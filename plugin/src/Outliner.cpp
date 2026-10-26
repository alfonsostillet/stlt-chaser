// STLT-OUTLINER: outlines drawn inside every slice of a view, so they never bleed into
// neighbours. Static outlines can feather inward; animated ones become tapered lines that
// run around each slice's edge, driven by Phase (animate it in Resolume).
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
	PID_VIEW,
	PID_RED,
	PID_GREEN,
	PID_BLUE,
	PID_WIDTH,
	PID_FEATHER,
	PID_ANIMATE,
	PID_PHASE,
	PID_FAN,
	PID_RANDOMISE,
	PID_LENGTH,
	PID_COUNT_LINES,
	PID_FLIP,
	PID_ODD_EVEN,
	PID_ENVELOPE,
	PID_SHOW_ORIGINAL,
	PID_LIT_ONLY,
	PID_COUNT
};

const int MAX_POINTS = 64;// Corners per slice the shader can follow.
const int MAX_LINES  = 16;

const char vertexShaderBody[] = R"(
layout( location = 0 ) in vec2 compPos;
out vec2 pixel;
out vec2 contentUV;
uniform vec2 compSize;
void main()
{
	gl_Position = compToClip( compPos );
	pixel       = compPos * compSize;
	contentUV   = vec2( compPos.x, 1.0 - compPos.y );
}
)";

// Distance from the slice's edge and position along its perimeter, then either a static
// band (with an inward feather) or `count` tapered lines chasing around the edge.
const char fragmentShaderCode[] = R"(#version 410 core
uniform vec2 points[ 64 ];   // Slice outline in composition pixels, clockwise on screen.
uniform float along[ 64 ];   // Perimeter distance at each point.
uniform int pointCount;
uniform float perimeter;
uniform vec4 colour;
uniform float width;
uniform float feather;
uniform int animate;
uniform float head;          // Position of the first line's head, 0..1 around the perimeter.
uniform int direction;       // 1 clockwise, -1 anticlockwise, 0 both ways (mirrored).
uniform float lineLength;    // 0..1 of the perimeter.
uniform int lineCount;
uniform int useCurve;
uniform float curve[ 256 ];
uniform sampler2D inputTexture;
uniform vec2 maxUV;
uniform int litOnly;         // Only where the input shows something (e.g. the slices a Chaser above lit).
in vec2 pixel;
in vec2 contentUV;
out vec4 fragColor;

float taperAt( float behind )
{
	if( behind >= lineLength )
		return 0.0;
	float x = behind / lineLength;
	return useCurve != 0 ? curve[ int( x * 255.0 ) ] : 1.0 - x;
}

void main()
{
	float best = 1e20;
	float s    = 0.0;
	for( int i = 0; i < pointCount; ++i )
	{
		vec2 a  = points[ i ];
		vec2 b  = points[ ( i + 1 ) % pointCount ];
		vec2 ab = b - a;
		float t = clamp( dot( pixel - a, ab ) / max( dot( ab, ab ), 1e-6 ), 0.0, 1.0 );
		float d = distance( pixel, a + ab * t );
		if( d < best )
		{
			best = d;
			s    = ( along[ i ] + t * length( ab ) ) / perimeter;
		}
	}

	float alpha;
	if( animate == 0 )
	{
		// Full strength across the width, then a feather fading further in.
		alpha = feather > 0.0 ? clamp( 1.0 - ( best - width ) / feather, 0.0, 1.0 ) : clamp( width - best + 0.5, 0.0, 1.0 );
	}
	else
	{
		float strength = 0.0;
		for( int i = 0; i < lineCount; ++i )
		{
			float h = fract( head + float( i ) / float( lineCount ) );
			if( direction >= 0 )
				strength = max( strength, taperAt( fract( h - s ) ) );
			if( direction <= 0 )
				strength = max( strength, taperAt( fract( s - ( 1.0 - h ) ) ) );
		}
		// The line thins towards its tail.
		alpha = clamp( width * strength - best + 0.5, 0.0, 1.0 );
	}
	if( litOnly != 0 )
		alpha *= texture( inputTexture, contentUV * maxUV ).a;
	if( alpha <= 0.0 )
		discard;
	fragColor = vec4( colour.rgb, 1.0 ) * colour.a * alpha;
}
)";

const char copyFragmentShader[] = R"(#version 410 core
uniform sampler2D inputTexture;
uniform vec2 maxUV;
in vec2 uv;
out vec4 fragColor;
void main()
{
	fragColor = texture( inputTexture, uv * maxUV );
}
)";

const char copyVertexShader[] = R"(#version 410 core
layout( location = 0 ) in vec4 vPosition;
layout( location = 1 ) in vec2 vUV;
out vec2 uv;
void main()
{
	gl_Position = vPosition;
	uv          = vUV;
}
)";

float Hash( size_t index )
{
	uint32_t h = (uint32_t)index * 2654435761u + 0x9e3779b9u;
	h ^= h >> 15;
	h *= 2246822519u;
	h ^= h >> 13;
	return (float)( h & 0xffffff ) / (float)0x1000000;
}
}// namespace

class Outliner : public StilletchaserPlugin
{
public:
	Outliner()
	{
		SetMinInputs( 1 );
		SetMaxInputs( 1 );
		SetOptionParamInfo( PID_VIEW, "View", 1, 0.f );
		SetParamElementInfo( PID_VIEW, 0, "All", 0.f );
		SetParamInfo( PID_RED, "Red", FF_TYPE_RED, 1.f );
		SetParamInfo( PID_GREEN, "Green", FF_TYPE_GREEN, 1.f );
		SetParamInfo( PID_BLUE, "Blue", FF_TYPE_BLUE, 1.f );
		SetRangedParamInfo( PID_WIDTH, "Width", FF_TYPE_STANDARD, 10.f, 1.f, 300.f );
		SetRangedParamInfo( PID_FEATHER, "Feather", FF_TYPE_STANDARD, 0.f, 0.f, 500.f );
		SetParamInfo( PID_ANIMATE, "Animate", FF_TYPE_BOOLEAN, false );
		SetParamInfo( PID_PHASE, "Phase", FF_TYPE_STANDARD, 0.f );
		SetParamInfo( PID_FAN, "Fan", FF_TYPE_STANDARD, 0.f );
		SetParamInfo( PID_RANDOMISE, "Randomise", FF_TYPE_STANDARD, 0.f );
		SetRangedParamInfo( PID_LENGTH, "Length", FF_TYPE_STANDARD, 0.25f, 0.01f, 1.f );
		SetRangedParamInfo( PID_COUNT_LINES, "Count", FF_TYPE_INTEGER, 1.f, 1.f, (float)MAX_LINES );
		SetParamInfo( PID_FLIP, "Flip Direction", FF_TYPE_BOOLEAN, false );
		SetParamInfo( PID_ODD_EVEN, "Odd/Even", FF_TYPE_BOOLEAN, false );
		SetOptionParamInfo( PID_ENVELOPE, "Envelope", 1, 0.f );
		SetParamElementInfo( PID_ENVELOPE, 0, "Taper", 0.f );
		SetParamInfo( PID_SHOW_ORIGINAL, "Show Original", FF_TYPE_BOOLEAN, true );
		SetParamInfo( PID_LIT_ONLY, "Lit Slices Only", FF_TYPE_BOOLEAN, false );
		for( int id = PID_PHASE; id <= PID_ENVELOPE; ++id )
			SetParamGroup( id, "Animation" );

		values[ PID_VIEW ]  = 0.f;
		values[ PID_RED ]   = values[ PID_GREEN ] = values[ PID_BLUE ] = 1.f;
		values[ PID_WIDTH ] = 10.f;
		values[ PID_FEATHER ] = values[ PID_ANIMATE ] = values[ PID_PHASE ] = values[ PID_FAN ] = values[ PID_RANDOMISE ] = 0.f;
		values[ PID_LENGTH ]      = 0.25f;
		values[ PID_COUNT_LINES ] = 1.f;
		values[ PID_FLIP ] = values[ PID_ODD_EVEN ] = values[ PID_ENVELOPE ] = values[ PID_LIT_ONLY ] = 0.f;
		values[ PID_SHOW_ORIGINAL ] = 1.f;

		doc        = DocumentWatcher::Instance().Current();
		docVersion = DocumentWatcher::Instance().Version();
		RefreshMenus( false );
	}

	FFResult InitGL( const FFGLViewportStruct* vp ) override
	{
		std::string vertex = std::string( CompositionVertexHeader() ) + vertexShaderBody;
		if( !shader.Compile( vertex, fragmentShaderCode ) || !copyShader.Compile( copyVertexShader, copyFragmentShader ) || !quad.Initialise() ||
			!mesh.Init( { 2 } ) )
		{
			DeInitGL();
			return FF_FAIL;
		}
		return CFFGLPlugin::InitGL( vp );
	}

	FFResult DeInitGL() override
	{
		shader.FreeGLResources();
		copyShader.FreeGLResources();
		quad.Release();
		mesh.Release();
		return FF_SUCCESS;
	}

	FFResult SetFloatParameter( unsigned int index, float value ) override
	{
		if( index >= PID_COUNT )
			return FF_FAIL;
		values[ index ] = value;
		if( index == PID_ANIMATE )
			UpdateVisibility( true );
		return FF_SUCCESS;
	}

	float GetFloatParameter( unsigned int index ) override
	{
		return index < PID_COUNT ? values[ index ] : 0.f;
	}

	const char* GetShortName() override
	{
		static const char* sname = "STOutline";
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
		if( values[ PID_SHOW_ORIGINAL ] > 0.5f )
		{
			ScopedShaderBinding copyBinding( copyShader.GetGLID() );
			ScopedSamplerActivation activateSampler( 0 );
			Scoped2DTextureBinding textureBinding( input.Handle );
			FFGLTexCoords maxCoords = GetMaxGLTexCoords( input );
			copyShader.Set( "inputTexture", 0 );
			copyShader.Set( "maxUV", maxCoords.s, maxCoords.t );
			quad.Draw();
		}
		if( doc->slices.empty() )
			return FF_SUCCESS;

		const View& view = doc->views[ Option( values[ PID_VIEW ], (int)doc->views.size() ) ];
		std::vector< float > vertices;
		std::vector< std::pair< GLint, GLsizei > > ranges;
		for( const Slice& slice : doc->slices )
		{
			ranges.push_back( { (GLint)( vertices.size() / 2 ), (GLsizei)slice.indices.size() } );
			for( uint16_t i : slice.indices )
				vertices.insert( vertices.end(), { slice.points[ i ].x, slice.points[ i ].y } );
		}
		mesh.Upload( vertices );

		const bool animate  = values[ PID_ANIMATE ] > 0.5f;
		const Envelope* env = ChosenEnvelope( *doc, values[ PID_ENVELOPE ] );
		ScopedShaderBinding shaderBinding( shader.GetGLID() );
		const GLuint program = shader.GetGLID();
		ScopedSamplerActivation activateSampler( 0 );
		Scoped2DTextureBinding textureBinding( input.Handle );
		const FFGLTexCoords maxCoords = GetMaxGLTexCoords( input );
		shader.Set( "inputTexture", 0 );
		shader.Set( "maxUV", maxCoords.s, maxCoords.t );
		shader.Set( "litOnly", values[ PID_LIT_ONLY ] > 0.5f ? 1 : 0 );
		shader.Set( "compSize", doc->compWidth, doc->compHeight );
		shader.Set( "colour", values[ PID_RED ], values[ PID_GREEN ], values[ PID_BLUE ], 1.f );
		shader.Set( "width", std::max( values[ PID_WIDTH ], 0.f ) );
		shader.Set( "feather", std::max( values[ PID_FEATHER ], 0.f ) );
		shader.Set( "animate", animate ? 1 : 0 );
		shader.Set( "lineLength", std::clamp( values[ PID_LENGTH ], 0.01f, 1.f ) );
		shader.Set( "lineCount", std::clamp( (int)std::lround( values[ PID_COUNT_LINES ] ), 1, MAX_LINES ) );
		shader.Set( "useCurve", env ? 1 : 0 );
		if( env )
			glUniform1fv( glGetUniformLocation( program, "curve" ), 256, env->lut.data() );

		// Outlines go over the original (premultiplied alpha).
		glEnable( GL_BLEND );
		glBlendFunc( GL_ONE, GL_ONE_MINUS_SRC_ALPHA );
		ScopedVAOBinding vaoBinding( mesh.VAO() );
		int shown = 0;
		for( size_t s = 0; s < doc->slices.size(); ++s )
		{
			const Slice& slice = doc->slices[ s ];
			if( !view.includes[ s ] || slice.points.size() > MAX_POINTS )
				continue;
			UploadOutline( program, slice );
			if( animate )
			{
				const Vec2 centre = SliceCentre( slice );
				const float fromCentre = std::hypot( centre.x - 0.5f, centre.y - 0.5f );
				shader.Set( "head", values[ PID_PHASE ] + values[ PID_FAN ] * fromCentre + values[ PID_RANDOMISE ] * Hash( s ) );
				shader.Set( "direction", Direction( centre, shown ) );
			}
			glDrawArrays( GL_TRIANGLES, ranges[ s ].first, ranges[ s ].second );
			++shown;
		}
		glDisable( GL_BLEND );
		return FF_SUCCESS;
	}

private:
	void RefreshMenus( bool raiseEvents )
	{
		const auto views     = ViewNames( *doc );
		const auto envelopes = EnvelopeNames( *doc, "Taper" );
		SetParamElements( PID_VIEW, views, Indices( views.size() ), raiseEvents );
		SetParamElements( PID_ENVELOPE, envelopes, Indices( envelopes.size() ), raiseEvents );
		UpdateVisibility( raiseEvents );
	}

	// Feather is for static outlines; the animation controls only matter when animating.
	void UpdateVisibility( bool raiseEvents )
	{
		const bool animate = values[ PID_ANIMATE ] > 0.5f;
		SetParamVisibility( PID_FEATHER, !animate, raiseEvents );
		for( int id = PID_PHASE; id <= PID_ENVELOPE; ++id )
			SetParamVisibility( id, animate, raiseEvents );
	}

	// Clockwise by default. Flip Direction mirrors the stage: slices right of centre run
	// clockwise, left of centre anticlockwise, centred ones both ways. Odd/Even reverses every other slice.
	int Direction( Vec2 centre, int shownIndex ) const
	{
		int direction = 1;
		if( values[ PID_FLIP ] > 0.5f )
		{
			if( std::fabs( centre.x - 0.5f ) < 0.02f )
				direction = 0;
			else
				direction = centre.x > 0.5f ? 1 : -1;
		}
		if( values[ PID_ODD_EVEN ] > 0.5f && shownIndex % 2 == 1 )
			direction = -direction;
		return direction;
	}

	// The outline in composition pixels, ordered clockwise on screen, with distances along it.
	void UploadOutline( GLuint program, const Slice& slice )
	{
		std::vector< Vec2 > pts;
		for( const Vec2& p : slice.points )
			pts.push_back( { p.x * doc->compWidth, p.y * doc->compHeight } );
		float area = 0.f;
		for( size_t i = 0; i < pts.size(); ++i )
		{
			const Vec2& a = pts[ i ];
			const Vec2& b = pts[ ( i + 1 ) % pts.size() ];
			area += a.x * b.y - b.x * a.y;
		}
		// With y pointing down a positive area is clockwise on screen.
		if( area < 0.f )
			std::reverse( pts.begin(), pts.end() );
		std::vector< float > flat, along;
		float total = 0.f;
		for( size_t i = 0; i < pts.size(); ++i )
		{
			flat.insert( flat.end(), { pts[ i ].x, pts[ i ].y } );
			along.push_back( total );
			const Vec2& next = pts[ ( i + 1 ) % pts.size() ];
			total += std::hypot( next.x - pts[ i ].x, next.y - pts[ i ].y );
		}
		glUniform2fv( glGetUniformLocation( program, "points" ), (GLsizei)pts.size(), flat.data() );
		glUniform1fv( glGetUniformLocation( program, "along" ), (GLsizei)along.size(), along.data() );
		shader.Set( "pointCount", (int)pts.size() );
		shader.Set( "perimeter", std::max( total, 1e-3f ) );
	}

	FFGLShader shader, copyShader;
	FFGLScreenQuad quad;
	FloatVertexBuffer mesh;
	std::shared_ptr< const ChaseDocument > doc;
	uint64_t docVersion = 0;
	float values[ PID_COUNT ];
};

static CFFGLPluginInfo PluginInfo(
	PluginFactory< Outliner >,
	"STOL",          // Plugin unique ID
	"STLT-OUTLINER", // Plugin name
	2,               // API major version number
	1,               // API minor version number
	0,               // Plugin major version number
	1,               // Plugin minor version number
	FF_EFFECT,
	"Outlines inside Advanced Output slices, static or running around their edges",
	"Stilletchaser" );
