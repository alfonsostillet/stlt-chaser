// STLT-WIPER: each step of a sequence sends a gradient wipe across its slices.
// Step (0..1) runs through the sequence Loops times; Resolume animates it (BPM sync, timeline, FFT).
// Direction is automatic: vertical slices wipe bottom to top, horizontal ones wipe away from
// the centre of the stage (left to right on the right half, right to left on the left half).
#include <FFGLSDK.h>
#include <memory>
#include "ChaseDocument.h"
#include "PluginCommon.h"
using namespace ffglex;
using namespace stilletchaser;

namespace
{
enum ParamID
{
	PID_SEQUENCE,
	PID_STEP,
	PID_SCALING,
	PID_LENGTH,
	PID_OVERLAP,
	PID_LOOPS,
	PID_FLIP,
	PID_ODD_EVEN,
	PID_SWAP,
	PID_ENVELOPE,
	PID_COUNT
};

const int MAX_LOOPS = 16;

const char fragmentShaderCode[] = R"(#version 410 core
uniform sampler2D inputTexture;
uniform vec2 maxUV;
uniform float head;     // Leading edge position along the wipe, 0..1+length.
uniform float len;      // Length of the gradient band, 0..1 of the slice.
uniform int alongY;     // Wipe along the slice's y edge instead of its x edge.
uniform int reversed;   // Run from the far edge back.
uniform int useCurve;
uniform float curve[ 256 ];
in vec2 uv;
in vec2 local;
out vec4 fragColor;
void main()
{
	float d = alongY != 0 ? local.y : local.x;
	if( reversed != 0 )
		d = 1.0 - d;
	// 0 at the leading edge, 1 at the tail of the band.
	float x = ( head - d ) / len;
	if( x < 0.0 || x > 1.0 )
		discard;
	float a = useCurve != 0 ? curve[ int( x * 255.0 ) ] : 1.0 - x;
	fragColor = texture( inputTexture, uv * maxUV ) * a;
}
)";

const char vertexShaderBody[] = R"(
layout( location = 0 ) in vec2 compPos;
layout( location = 1 ) in vec2 contentUV;
layout( location = 2 ) in vec2 sliceLocal;
out vec2 uv;
out vec2 local;
void main()
{
	gl_Position = compToClip( compPos );
	uv          = contentUV;
	local       = sliceLocal;
}
)";
}// namespace

class Wiper : public StilletchaserPlugin
{
public:
	Wiper()
	{
		SetMinInputs( 1 );
		SetMaxInputs( 1 );
		SetOptionParamInfo( PID_SEQUENCE, "Sequence", 1, 0.f );
		SetParamElementInfo( PID_SEQUENCE, 0, "-", 0.f );
		SetParamInfo( PID_STEP, "Step", FF_TYPE_STANDARD, 0.f );
		SetOptionParamInfo( PID_SCALING, "Scaling", 3, (float)SCALING_MASK );
		SetParamElementInfo( PID_SCALING, SCALING_MASK, "Mask", (float)SCALING_MASK );
		SetParamElementInfo( PID_SCALING, SCALING_FILL, "Fill", (float)SCALING_FILL );
		SetParamElementInfo( PID_SCALING, SCALING_STRETCH, "Stretch", (float)SCALING_STRETCH );
		SetRangedParamInfo( PID_LENGTH, "Length", FF_TYPE_STANDARD, 0.25f, 0.01f, 1.f );
		SetRangedParamInfo( PID_OVERLAP, "Overlap", FF_TYPE_STANDARD, 0.f, 0.f, 0.95f );
		SetRangedParamInfo( PID_LOOPS, "Loops", FF_TYPE_INTEGER, 1.f, 1.f, (float)MAX_LOOPS );
		SetParamInfo( PID_FLIP, "Flip Direction", FF_TYPE_BOOLEAN, false );
		SetParamInfo( PID_ODD_EVEN, "Odd/Even", FF_TYPE_BOOLEAN, false );
		SetParamInfo( PID_SWAP, "Swap Directions", FF_TYPE_BOOLEAN, false );
		SetOptionParamInfo( PID_ENVELOPE, "Envelope", 1, 0.f );
		SetParamElementInfo( PID_ENVELOPE, 0, "Gradient", 0.f );
		for( int i = 0; i < PID_COUNT; ++i )
			values[ i ] = GetDefault( i );

		doc        = DocumentWatcher::Instance().Current();
		docVersion = DocumentWatcher::Instance().Version();
		RefreshMenus( false );
	}

	FFResult InitGL( const FFGLViewportStruct* vp ) override
	{
		std::string vertex = std::string( CompositionVertexHeader() ) + vertexShaderBody;
		if( !shader.Compile( vertex, fragmentShaderCode ) || !mesh.Init( { 2, 2, 2 } ) )
		{
			DeInitGL();
			return FF_FAIL;
		}
		return CFFGLPlugin::InitGL( vp );
	}

	FFResult DeInitGL() override
	{
		shader.FreeGLResources();
		mesh.Release();
		return FF_SUCCESS;
	}

	FFResult SetFloatParameter( unsigned int index, float value ) override
	{
		if( index >= PID_COUNT )
			return FF_FAIL;
		values[ index ] = value;
		return FF_SUCCESS;
	}

	float GetFloatParameter( unsigned int index ) override
	{
		return index < PID_COUNT ? values[ index ] : 0.f;
	}

	const char* GetShortName() override
	{
		static const char* sname = "STWiper";
		return sname;
	}

	FFResult ProcessOpenGL( ProcessOpenGLStruct* pGL ) override
	{
		if( pGL->numInputTextures < 1 || pGL->inputTextures[ 0 ] == nullptr )
			return FF_FAIL;
		const FFGLTextureStruct& input = *pGL->inputTextures[ 0 ];
		DocumentWatcher& watcher       = DocumentWatcher::Instance();
		doc                            = watcher.Current();
		if( watcher.Version() != docVersion )
		{
			docVersion = watcher.Version();
			RefreshMenus( true );
		}

		glClearColor( 0.f, 0.f, 0.f, 0.f );
		glClear( GL_COLOR_BUFFER_BIT );
		if( doc->slices.empty() || doc->sequences.empty() )
			return FF_SUCCESS;

		BuildMesh( input );
		mesh.Upload( vertices );

		const Sequence& seq = doc->sequences[ Option( values[ PID_SEQUENCE ], (int)doc->sequences.size() ) ];
		const int count     = (int)seq.steps.size();
		const int loops     = std::clamp( (int)std::lround( values[ PID_LOOPS ] ), 1, MAX_LOOPS );
		const int total     = count * loops;
		const float length  = std::clamp( values[ PID_LENGTH ], 0.01f, 1.f );
		// With overlap a wipe lasts longer than one step, so the next one starts before it ends.
		const float duration = 1.f / ( 1.f - std::clamp( values[ PID_OVERLAP ], 0.f, 0.95f ) );
		const float position = std::min( values[ PID_STEP ], 0.99999f ) * (float)total;
		const Envelope* env  = ChosenEnvelope( *doc, values[ PID_ENVELOPE ] );

		ScopedShaderBinding shaderBinding( shader.GetGLID() );
		ScopedSamplerActivation activateSampler( 0 );
		Scoped2DTextureBinding textureBinding( input.Handle );
		FFGLTexCoords maxCoords = GetMaxGLTexCoords( input );
		shader.Set( "inputTexture", 0 );
		shader.Set( "maxUV", maxCoords.s, maxCoords.t );
		shader.Set( "len", length );
		shader.Set( "useCurve", env ? 1 : 0 );
		if( env )
			glUniform1fv( glGetUniformLocation( shader.GetGLID(), "curve" ), 256, env->lut.data() );

		// Overlapping wipes in one slice combine by keeping the brightest.
		glEnable( GL_BLEND );
		glBlendEquation( GL_MAX );
		ScopedVAOBinding vaoBinding( mesh.VAO() );
		const int newest = (int)std::floor( position );
		const int oldest = (int)std::floor( position - duration );
		for( int j = oldest; j <= newest; ++j )
		{
			float t = ( position - (float)j ) / duration;
			if( t < 0.f || t >= 1.f )
				continue;
			// Wrap around the end of the timeline so a looped Step plays seamlessly.
			const int stepIndex = ( ( j % total ) + total ) % total % count;
			const bool odd      = values[ PID_ODD_EVEN ] > 0.5f && stepIndex % 2 == 1;
			shader.Set( "head", t * ( 1.f + length ) );
			for( int slice : seq.steps[ stepIndex ] )
			{
				const SliceRange& range = ranges[ slice ];
				bool reversed           = range.reversed != ( values[ PID_FLIP ] > 0.5f ) != odd;
				shader.Set( "alongY", range.alongY ? 1 : 0 );
				shader.Set( "reversed", reversed ? 1 : 0 );
				glDrawArrays( GL_TRIANGLES, range.first, range.count );
			}
		}
		glBlendEquation( GL_FUNC_ADD );
		glDisable( GL_BLEND );
		return FF_SUCCESS;
	}

private:
	struct SliceRange
	{
		GLint first;
		GLsizei count;
		bool alongY;
		bool reversed;
	};

	void RefreshMenus( bool raiseEvents )
	{
		const auto sequences = SequenceNames( *doc );
		const auto envelopes = EnvelopeNames( *doc, "Gradient" );
		SetParamElements( PID_SEQUENCE, sequences, Indices( sequences.size() ), raiseEvents );
		SetParamElements( PID_ENVELOPE, envelopes, Indices( envelopes.size() ), raiseEvents );
	}

	float GetDefault( int index )
	{
		switch( index )
		{
		case PID_SCALING: return (float)SCALING_MASK;
		case PID_LENGTH:  return 0.25f;
		case PID_LOOPS:   return 1.f;
		default:          return 0.f;
		}
	}

	// Every slice's triangles with content and slice-local coordinates, and its wipe direction.
	void BuildMesh( const FFGLTextureStruct& input )
	{
		vertices.clear();
		ranges.clear();
		const int scaling         = Option( values[ PID_SCALING ], 3 );
		const float contentAspect = input.Height ? (float)input.Width / (float)input.Height : 1.f;
		const bool swap           = values[ PID_SWAP ] > 0.5f;
		for( const Slice& slice : doc->slices )
		{
			const Vec2 size   = SliceSize( *doc, slice );
			bool vertical     = size.y > size.x;
			if( swap )
				vertical = !vertical;
			// Local y runs down the slice, so bottom-to-top is the reversed direction.
			const bool reversed = vertical ? true : SliceCentre( slice ).x < 0.5f;
			ranges.push_back( { (GLint)( vertices.size() / 6 ), (GLsizei)slice.indices.size(), vertical, reversed } );
			for( uint16_t i : slice.indices )
			{
				const Vec2 p     = slice.points[ i ];
				const Vec2 uv    = ContentUV( *doc, slice, p, scaling, contentAspect );
				const Vec2 local = SliceLocal( slice, p );
				vertices.insert( vertices.end(), { p.x, p.y, uv.x, uv.y, local.x, local.y } );
			}
		}
	}

	FFGLShader shader;
	FloatVertexBuffer mesh;
	std::vector< float > vertices;
	std::vector< SliceRange > ranges;
	std::shared_ptr< const ChaseDocument > doc;
	uint64_t docVersion = 0;
	float values[ PID_COUNT ];
};

static CFFGLPluginInfo PluginInfo(
	PluginFactory< Wiper >,
	"STWP",       // Plugin unique ID
	"STLT-WIPER", // Plugin name
	2,            // API major version number
	1,            // API minor version number
	0,            // Plugin major version number
	1,            // Plugin minor version number
	FF_EFFECT,
	"Gradient wipes through Advanced Output slices, step by step through a Stilletchaser sequence",
	"Stilletchaser" );
