#include "Stilletchaser.h"
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <string>
using namespace ffglex;
using namespace stilletchaser;

static CFFGLPluginInfo PluginInfo(
	PluginFactory< Stilletchaser >,
	"STCH",         // Plugin unique ID
	"STLT-CHASER",  // Plugin name
	2,              // API major version number
	1,              // API minor version number
	0,              // Plugin major version number
	2,              // Plugin minor version number
	FF_EFFECT,
	"Chases and delays Advanced Output slices with sequences made in the Stilletchaser editor",
	"Stilletchaser" );

enum ParamID
{
	PID_DRIVER,
	PID_SEQUENCE,
	PID_STEP,
	PID_SCALING,
	PID_VIEW,
	PID_ECHOES,
	PID_ENVELOPE,
	PID_SUSTAIN,
	PID_RELEASE,
	PID_DELAYER,
	PID_DELAY_SEQUENCE,
	PID_DELAY,
	PID_DELAY_UNIT,
	PID_MAX_FRAMES,
	PID_MAX_SECONDS,
	PID_MAX_BEATS,
	PID_QUALITY,
	PID_REVERSE,
	PID_AUTO_RESET,
	PID_RESET_MINUTES,
};

enum Driver
{
	DRIVER_CHASER,
	DRIVER_NONE,
};

enum DelayUnit
{
	UNIT_FRAMES,
	UNIT_SECONDS,
	UNIT_BEATS,
};

static const int MAX_ECHOES        = 32;
static const int MAX_HISTORY       = 1500;// Frames; about 25 s at 60 fps.
static const size_t MAX_HISTORY_VRAM = (size_t)3 << 30;
static const int FLOATS_PER_VERTEX = 5;// position xy, content uv, opacity

static const char vertexShaderCode[] = R"(#version 410 core
uniform vec2 maxUV;
layout( location = 0 ) in vec2 compPos;
layout( location = 1 ) in vec2 contentUV;
layout( location = 2 ) in float opacity;
out vec2 uv;
out float level;
void main()
{
	// compPos is composition space with y down; clip space has y up.
	gl_Position = vec4( compPos.x * 2.0 - 1.0, 1.0 - compPos.y * 2.0, 0.0, 1.0 );
	uv          = contentUV * maxUV;
	level       = opacity;
}
)";

static const char fragmentShaderCode[] = R"(#version 410 core
uniform sampler2D inputTexture;
in vec2 uv;
in float level;
out vec4 fragColor;
void main()
{
	fragColor = texture( inputTexture, uv ) * level;
}
)";

Stilletchaser::Stilletchaser()
{
	SetMinInputs( 1 );
	SetMaxInputs( 1 );

	SetOptionParamInfo( PID_DRIVER, "Driver", 2, driver );
	SetParamElementInfo( PID_DRIVER, DRIVER_CHASER, "Chaser", (float)DRIVER_CHASER );
	SetParamElementInfo( PID_DRIVER, DRIVER_NONE, "None (all slices)", (float)DRIVER_NONE );

	SetOptionParamInfo( PID_SEQUENCE, "Sequence", 1, 0.f );
	SetParamElementInfo( PID_SEQUENCE, 0, "-", 0.f );
	SetParamInfo( PID_STEP, "Step", FF_TYPE_STANDARD, step );

	SetOptionParamInfo( PID_SCALING, "Scaling", 3, scaling );
	SetParamElementInfo( PID_SCALING, SCALING_MASK, "Mask", (float)SCALING_MASK );
	SetParamElementInfo( PID_SCALING, SCALING_FILL, "Fill", (float)SCALING_FILL );
	SetParamElementInfo( PID_SCALING, SCALING_STRETCH, "Stretch", (float)SCALING_STRETCH );

	SetOptionParamInfo( PID_VIEW, "View", 1, 0.f );
	SetParamElementInfo( PID_VIEW, 0, "All", 0.f );

	SetRangedParamInfo( PID_ECHOES, "Echoes", FF_TYPE_INTEGER, echoes, 0.f, (float)MAX_ECHOES );

	SetOptionParamInfo( PID_ENVELOPE, "Envelope", 1, 0.f );
	SetParamElementInfo( PID_ENVELOPE, 0, "Sustain / Release", 0.f );
	SetParamInfo( PID_SUSTAIN, "Sustain", FF_TYPE_STANDARD, sustain );
	SetParamInfo( PID_RELEASE, "Release", FF_TYPE_STANDARD, release );

	// Delayer module.
	SetParamInfo( PID_DELAYER, "Delayer", FF_TYPE_BOOLEAN, false );
	SetOptionParamInfo( PID_DELAY_SEQUENCE, "Delay Sequence", 1, 0.f );
	SetParamElementInfo( PID_DELAY_SEQUENCE, 0, "-", 0.f );
	SetParamInfo( PID_DELAY, "Delay", FF_TYPE_STANDARD, delay );
	SetOptionParamInfo( PID_DELAY_UNIT, "Set Delay In", 3, delayUnit );
	SetParamElementInfo( PID_DELAY_UNIT, UNIT_FRAMES, "Frames", (float)UNIT_FRAMES );
	SetParamElementInfo( PID_DELAY_UNIT, UNIT_SECONDS, "Seconds", (float)UNIT_SECONDS );
	SetParamElementInfo( PID_DELAY_UNIT, UNIT_BEATS, "Beats", (float)UNIT_BEATS );
	SetRangedParamInfo( PID_MAX_FRAMES, "Max Frames", FF_TYPE_INTEGER, maxFrames, 1.f, (float)MAX_HISTORY );
	SetRangedParamInfo( PID_MAX_SECONDS, "Max Seconds", FF_TYPE_STANDARD, maxSeconds, 0.05f, 25.f );
	SetRangedParamInfo( PID_MAX_BEATS, "Max Beats", FF_TYPE_STANDARD, maxBeats, 0.25f, 32.f );
	SetRangedParamInfo( PID_QUALITY, "Quality", FF_TYPE_STANDARD, quality, 0.1f, 1.f );
	SetParamInfo( PID_REVERSE, "Reverse", FF_TYPE_BOOLEAN, false );
	SetParamInfo( PID_AUTO_RESET, "Auto Reset", FF_TYPE_BOOLEAN, true );
	SetRangedParamInfo( PID_RESET_MINUTES, "Reset After (min)", FF_TYPE_INTEGER, resetMinutes, 1.f, 60.f );
	for( unsigned int id = PID_DELAYER; id <= PID_RESET_MINUTES; ++id )
		SetParamGroup( id, "Delayer" );

	doc        = DocumentWatcher::Instance().Current();
	docVersion = DocumentWatcher::Instance().Version();
	RefreshMenus( false );
	if( !doc->error.empty() )
		FFGLLog::LogToHost( ( "Stilletchaser: " + doc->error ).c_str() );
}

// Sequence, View and Envelope menus list what is in the editor's document.
void Stilletchaser::RefreshMenus( bool raiseEvents )
{
	const auto sequences = SequenceNames( *doc );
	const auto views     = ViewNames( *doc );
	const auto envelopes = EnvelopeNames( *doc, "Sustain / Release" );
	SetParamElements( PID_SEQUENCE, sequences, Indices( sequences.size() ), raiseEvents );
	SetParamElements( PID_DELAY_SEQUENCE, sequences, Indices( sequences.size() ), raiseEvents );
	SetParamElements( PID_VIEW, views, Indices( views.size() ), raiseEvents );
	SetParamElements( PID_ENVELOPE, envelopes, Indices( envelopes.size() ), raiseEvents );
	UpdateVisibility( raiseEvents );
}

// Only the controls that do something with the current choices are shown.
void Stilletchaser::UpdateVisibility( bool raiseEvents )
{
	const bool chaser = Option( driver, 2 ) == DRIVER_CHASER;
	const bool curve  = std::lround( envelope ) > 0;
	for( unsigned int id : { PID_SEQUENCE, PID_STEP, PID_ECHOES, PID_ENVELOPE } )
		SetParamVisibility( id, chaser, raiseEvents );
	SetParamVisibility( PID_SUSTAIN, chaser && !curve, raiseEvents );
	SetParamVisibility( PID_RELEASE, chaser && !curve, raiseEvents );

	const bool delaying = delayer > 0.5f;
	const int unit      = Option( delayUnit, 3 );
	for( unsigned int id = PID_DELAY_SEQUENCE; id <= PID_RESET_MINUTES; ++id )
		SetParamVisibility( id, delaying, raiseEvents );
	SetParamVisibility( PID_MAX_FRAMES, delaying && unit == UNIT_FRAMES, raiseEvents );
	SetParamVisibility( PID_MAX_SECONDS, delaying && unit == UNIT_SECONDS, raiseEvents );
	SetParamVisibility( PID_MAX_BEATS, delaying && unit == UNIT_BEATS, raiseEvents );
	SetParamVisibility( PID_RESET_MINUTES, delaying && autoReset > 0.5f, raiseEvents );
}

FFResult Stilletchaser::InitGL( const FFGLViewportStruct* vp )
{
	if( !shader.Compile( vertexShaderCode, fragmentShaderCode ) || !history.InitGL() )
	{
		DeInitGL();
		return FF_FAIL;
	}
	glGenVertexArrays( 1, &vao );
	glGenBuffers( 1, &vbo );
	glBindVertexArray( vao );
	glBindBuffer( GL_ARRAY_BUFFER, vbo );
	glEnableVertexAttribArray( 0 );
	glVertexAttribPointer( 0, 2, GL_FLOAT, GL_FALSE, FLOATS_PER_VERTEX * sizeof( float ), (void*)0 );
	glEnableVertexAttribArray( 1 );
	glVertexAttribPointer( 1, 2, GL_FLOAT, GL_FALSE, FLOATS_PER_VERTEX * sizeof( float ), (void*)( 2 * sizeof( float ) ) );
	glEnableVertexAttribArray( 2 );
	glVertexAttribPointer( 2, 1, GL_FLOAT, GL_FALSE, FLOATS_PER_VERTEX * sizeof( float ), (void*)( 4 * sizeof( float ) ) );
	glBindVertexArray( 0 );
	glBindBuffer( GL_ARRAY_BUFFER, 0 );
	return CFFGLPlugin::InitGL( vp );
}

FFResult Stilletchaser::DeInitGL()
{
	shader.FreeGLResources();
	history.DeInitGL();
	if( vbo )
		glDeleteBuffers( 1, &vbo );
	if( vao )
		glDeleteVertexArrays( 1, &vao );
	vbo = vao = 0;
	return FF_SUCCESS;
}

void Stilletchaser::ComputeLevels( const ChaseDocument& d, std::vector< float >& levels ) const
{
	const View& v = d.views[ Option( view, (int)d.views.size() ) ];
	if( Option( driver, 2 ) == DRIVER_NONE || d.sequences.empty() )
	{
		levels.resize( d.slices.size() );
		for( size_t s = 0; s < d.slices.size(); ++s )
			levels[ s ] = Option( driver, 2 ) == DRIVER_NONE && v.includes[ s ] ? 1.f : 0.f;
		return;
	}
	levels.assign( d.slices.size(), 0.f );
	const Sequence& seq = d.sequences[ Option( sequence, (int)d.sequences.size() ) ];
	const int count     = (int)seq.steps.size();
	const Envelope* env = ChosenEnvelope( d, envelope );

	// Step 0..1 runs through the whole sequence. A step stays lit for 1 + Echoes steps,
	// and the opacity curve spans that whole life.
	const float position = std::min( step, 0.99999f ) * (float)count;
	const int current    = (int)std::floor( position );
	const float within   = position - (float)current;
	const int life       = 1 + std::clamp( (int)std::lround( echoes ), 0, MAX_ECHOES );

	for( int age = 0; age < life; ++age )
	{
		int index     = ( ( current - age ) % count + count ) % count;
		float t       = ( within + (float)age ) / (float)life;
		float opacity = env ? SampleLut( env->lut, t ) : SustainRelease( sustain, std::max( release, sustain ), t );
		if( opacity <= 0.f )
			continue;
		for( int slice : seq.steps[ index ] )
			if( v.includes[ slice ] )
				levels[ slice ] = std::max( levels[ slice ], opacity );
	}
}

bool Stilletchaser::DelayInFrames() const
{
	return Option( delayUnit, 3 ) == UNIT_FRAMES;
}

float Stilletchaser::MaxDelay() const
{
	switch( Option( delayUnit, 3 ) )
	{
	case UNIT_FRAMES:  return std::clamp( std::round( maxFrames ), 1.f, (float)MAX_HISTORY );
	case UNIT_SECONDS: return std::max( maxSeconds, 0.f );
	default:           return std::max( maxBeats, 0.f ) * 60.f / std::max( bpm, 1.f );
	}
}

// The delay sequence spreads the delay over the stage: slices in its first step are not
// delayed, slices in its last step get the full delay, slices it never lights are not delayed.
void Stilletchaser::ComputeDelays( const ChaseDocument& d, std::vector< float >& delays ) const
{
	delays.assign( d.slices.size(), 0.f );
	if( delayer <= 0.5f || d.sequences.empty() )
		return;
	const Sequence& seq = d.sequences[ Option( delaySequence, (int)d.sequences.size() ) ];
	const int count     = (int)seq.steps.size();
	const float full    = std::clamp( delay, 0.f, 1.f ) * MaxDelay();
	std::vector< int > firstStep( d.slices.size(), -1 );
	for( int i = 0; i < count; ++i )
		for( int slice : seq.steps[ i ] )
			if( firstStep[ slice ] < 0 )
				firstStep[ slice ] = i;
	for( size_t s = 0; s < d.slices.size(); ++s )
	{
		if( firstStep[ s ] < 0 )
			continue;
		float fraction = count > 1 ? (float)firstStep[ s ] / (float)( count - 1 ) : 0.f;
		if( reverse > 0.5f )
			fraction = 1.f - fraction;
		delays[ s ] = fraction * full;
	}
}

void Stilletchaser::UpdateHistory( const FFGLTextureStruct& input, GLuint hostFBO )
{
	const auto now = std::chrono::steady_clock::now();
	if( hasLastFrame )
	{
		double seconds = std::chrono::duration< double >( now - lastFrame ).count();
		// After a long pause the stored frames are stale: start over.
		if( autoReset > 0.5f && seconds > resetMinutes * 60.0 )
			history.Clear();
		if( seconds > 0.0 && seconds < 0.5 )
			framesPerSecond = framesPerSecond * 0.95f + (float)( 1.0 / seconds ) * 0.05f;
	}
	lastFrame    = now;
	hasLastFrame = true;
	frameTime    = std::chrono::duration< double >( now.time_since_epoch() ).count();

	if( delayer <= 0.5f )
	{
		if( history.Capacity() )
			history.Configure( 1, 1, 1 );// Give the VRAM back while the Delayer is off.
		return;
	}
	const float q    = std::clamp( quality, 0.1f, 1.f );
	const int width  = std::max( 1, (int)std::lround( input.Width * q ) );
	const int height = std::max( 1, (int)std::lround( input.Height * q ) );

	// Frames needed to cover the full delay. For delays in time this follows the frame rate,
	// which wobbles, so allocate with headroom in blocks and only resize on real changes:
	// resizing every frame would make the video stutter.
	int capacity = history.Capacity();
	if( DelayInFrames() )
		capacity = (int)MaxDelay() + 1;
	else
	{
		const int needed  = (int)std::ceil( MaxDelay() * framesPerSecond ) + 2;
		const int roomy   = ( (int)( needed * 1.25f ) / 16 + 1 ) * 16;
		if( capacity < needed || capacity > 2 * roomy )
			capacity = roomy;
	}
	capacity = std::clamp( capacity, 1, MAX_HISTORY + 1 );
	const size_t frameBytes = (size_t)width * height * 4;
	if( frameBytes * capacity > MAX_HISTORY_VRAM )
	{
		capacity = std::max( 2, (int)( MAX_HISTORY_VRAM / frameBytes ) );
		static bool warned = false;
		if( !warned )
			FFGLLog::LogToHost( "Stilletchaser: Delayer limited to 3 GB of video memory; lower Quality or the maximum delay" );
		warned = true;
	}
	history.Configure( capacity, width, height );
	history.Push( input, hostFBO, frameTime );
}

void Stilletchaser::BuildVertices( const ChaseDocument& d, const std::vector< float >& levels, const std::vector< float >& delays, const FFGLTextureStruct& input )
{
	vertices.clear();
	draws.clear();
	const int mode            = Option( scaling, 3 );
	const float contentAspect = input.Height ? (float)input.Width / (float)input.Height : 1.f;
	const bool delaying       = delayer > 0.5f && history.Filled() > 0;

	for( size_t s = 0; s < d.slices.size(); ++s )
	{
		if( levels[ s ] <= 0.f )
			continue;
		const Slice& slice = d.slices[ s ];
		SliceDraw draw{ (GLint)( vertices.size() / FLOATS_PER_VERTEX ), (GLsizei)slice.indices.size(), input.Handle, false };
		if( delaying )
		{
			GLuint frame = DelayInFrames() ? history.Frame( (int)std::lround( delays[ s ] ) ) : history.FrameAt( frameTime - delays[ s ] );
			draw         = { draw.first, draw.count, frame, true };
		}
		draws.push_back( draw );

		for( uint16_t i : slice.indices )
		{
			const Vec2 p  = slice.points[ i ];
			const Vec2 uv = ContentUV( d, slice, p, mode, contentAspect );
			vertices.insert( vertices.end(), { p.x, p.y, uv.x, uv.y, levels[ s ] } );
		}
	}
}

FFResult Stilletchaser::ProcessOpenGL( ProcessOpenGLStruct* pGL )
{
	if( pGL->numInputTextures < 1 || pGL->inputTextures[ 0 ] == nullptr )
		return FF_FAIL;
	const FFGLTextureStruct& input = *pGL->inputTextures[ 0 ];

	DocumentWatcher& watcher = DocumentWatcher::Instance();
	doc = watcher.Current();
	if( watcher.Version() != docVersion )
	{
		docVersion = watcher.Version();
		RefreshMenus( true );
	}

	// Record the frame even when nothing is lit, so the delay is ready when slices light up.
	UpdateHistory( input, pGL->HostFBO );

	glClearColor( 0.f, 0.f, 0.f, 0.f );
	glClear( GL_COLOR_BUFFER_BIT );
	if( doc->slices.empty() )
		return FF_SUCCESS;

	std::vector< float > levels;
	std::vector< float > delays;
	ComputeLevels( *doc, levels );
	ComputeDelays( *doc, delays );
	BuildVertices( *doc, levels, delays, input );
	if( vertices.empty() )
		return FF_SUCCESS;

	ScopedShaderBinding shaderBinding( shader.GetGLID() );
	ScopedSamplerActivation activateSampler( 0 );
	shader.Set( "inputTexture", 0 );
	const FFGLTexCoords inputMax = GetMaxGLTexCoords( input );

	ScopedVAOBinding vaoBinding( vao );
	ScopedVBOBinding vboBinding( vbo );
	glBufferData( GL_ARRAY_BUFFER, vertices.size() * sizeof( float ), vertices.data(), GL_STREAM_DRAW );
	for( const SliceDraw& draw : draws )
	{
		// History frames are stored at exactly their own size, so their whole area is image.
		Scoped2DTextureBinding textureBinding( draw.texture );
		if( draw.fromHistory )
			shader.Set( "maxUV", 1.f, 1.f );
		else
			shader.Set( "maxUV", inputMax.s, inputMax.t );
		glDrawArrays( GL_TRIANGLES, draw.first, draw.count );
	}
	return FF_SUCCESS;
}

FFResult Stilletchaser::SetFloatParameter( unsigned int index, float value )
{
	switch( index )
	{
	case PID_DRIVER:
		driver = value;
		UpdateVisibility( true );
		break;
	case PID_SEQUENCE: sequence = value; break;
	case PID_STEP:     step = value; break;
	case PID_SCALING:  scaling = value; break;
	case PID_VIEW:     view = value; break;
	case PID_ECHOES:   echoes = value; break;
	case PID_ENVELOPE:
		envelope = value;
		UpdateVisibility( true );
		break;
	case PID_SUSTAIN:  sustain = value; break;
	case PID_RELEASE:  release = value; break;
	case PID_DELAYER:
		delayer = value;
		UpdateVisibility( true );
		break;
	case PID_DELAY_SEQUENCE: delaySequence = value; break;
	case PID_DELAY:          delay = value; break;
	case PID_DELAY_UNIT:
		delayUnit = value;
		UpdateVisibility( true );
		break;
	case PID_MAX_FRAMES:  maxFrames = value; break;
	case PID_MAX_SECONDS: maxSeconds = value; break;
	case PID_MAX_BEATS:   maxBeats = value; break;
	case PID_QUALITY:     quality = value; break;
	case PID_REVERSE:     reverse = value; break;
	case PID_AUTO_RESET:
		autoReset = value;
		UpdateVisibility( true );
		break;
	case PID_RESET_MINUTES: resetMinutes = value; break;
	default:                return FF_FAIL;
	}
	return FF_SUCCESS;
}

float Stilletchaser::GetFloatParameter( unsigned int index )
{
	switch( index )
	{
	case PID_DRIVER:         return driver;
	case PID_SEQUENCE:       return sequence;
	case PID_STEP:           return step;
	case PID_SCALING:        return scaling;
	case PID_VIEW:           return view;
	case PID_ECHOES:         return echoes;
	case PID_ENVELOPE:       return envelope;
	case PID_SUSTAIN:        return sustain;
	case PID_RELEASE:        return release;
	case PID_DELAYER:        return delayer;
	case PID_DELAY_SEQUENCE: return delaySequence;
	case PID_DELAY:          return delay;
	case PID_DELAY_UNIT:     return delayUnit;
	case PID_MAX_FRAMES:     return maxFrames;
	case PID_MAX_SECONDS:    return maxSeconds;
	case PID_MAX_BEATS:      return maxBeats;
	case PID_QUALITY:        return quality;
	case PID_REVERSE:        return reverse;
	case PID_AUTO_RESET:     return autoReset;
	case PID_RESET_MINUTES:  return resetMinutes;
	default:                 return 0.f;
	}
}

char* Stilletchaser::GetParameterDisplay( unsigned int index )
{
	static char display[ 48 ];
	if( index == PID_STEP && doc && !doc->sequences.empty() )
	{
		const Sequence& seq = doc->sequences[ Option( sequence, (int)doc->sequences.size() ) ];
		int count           = (int)seq.steps.size();
		int current         = std::min( (int)( step * (float)count ), count - 1 ) + 1;
		std::snprintf( display, sizeof( display ), "%d / %d", current, count );
		return display;
	}
	if( index == PID_DELAY )
	{
		const float full = std::clamp( delay, 0.f, 1.f ) * MaxDelay();
		if( DelayInFrames() )
			std::snprintf( display, sizeof( display ), "%d frames", (int)std::lround( full ) );
		else
			std::snprintf( display, sizeof( display ), "%.2f s", full );
		return display;
	}
	if( index == PID_QUALITY )
	{
		std::snprintf( display, sizeof( display ), "%d%%", (int)std::lround( quality * 100.f ) );
		return display;
	}
	return CFFGLPlugin::GetParameterDisplay( index );
}
