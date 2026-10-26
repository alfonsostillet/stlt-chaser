#include "FrameHistory.h"
#include <algorithm>
#include <ffglex/FFGLScopedFBOBinding.h>
using namespace ffglex;

namespace stilletchaser
{
static const char copyVertexShader[] = R"(#version 410 core
uniform vec2 maxUV;
layout( location = 0 ) in vec4 vPosition;
layout( location = 1 ) in vec2 vUV;
out vec2 uv;
void main()
{
	gl_Position = vPosition;
	uv          = vUV * maxUV;
}
)";

static const char copyFragmentShader[] = R"(#version 410 core
uniform sampler2D inputTexture;
in vec2 uv;
out vec4 fragColor;
void main()
{
	fragColor = texture( inputTexture, uv );
}
)";

bool FrameHistory::InitGL()
{
	if( !copyShader.Compile( copyVertexShader, copyFragmentShader ) || !quad.Initialise() )
		return false;
	glGenFramebuffers( 1, &fbo );
	return true;
}

void FrameHistory::DeInitGL()
{
	Release();
	copyShader.FreeGLResources();
	quad.Release();
	if( fbo )
		glDeleteFramebuffers( 1, &fbo );
	fbo = 0;
}

void FrameHistory::Release()
{
	for( const Slot& slot : slots )
		glDeleteTextures( 1, &slot.texture );
	slots.clear();
	width = height = 0;
	head            = -1;
	filled          = 0;
}

GLuint FrameHistory::NewTexture() const
{
	GLuint texture = 0;
	glGenTextures( 1, &texture );
	Scoped2DTextureBinding binding( texture );
	glTexImage2D( GL_TEXTURE_2D, 0, GL_RGBA8, width, height, 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr );
	glTexParameteri( GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR );
	glTexParameteri( GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR );
	glTexParameteri( GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE );
	glTexParameteri( GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE );
	return texture;
}

void FrameHistory::Configure( int capacity, int newWidth, int newHeight )
{
	capacity  = std::max( 1, capacity );
	newWidth  = std::max( 1, newWidth );
	newHeight = std::max( 1, newHeight );
	if( newWidth != width || newHeight != height )
	{
		Release();
		width  = newWidth;
		height = newHeight;
	}
	if( capacity == (int)slots.size() )
		return;

	// Lay the kept frames out oldest to newest, then the empty slots; the ring continues from there.
	const int keep = std::min( filled, capacity );
	std::vector< Slot > resized;
	resized.reserve( capacity );
	for( int age = keep - 1; age >= 0; --age )
		resized.push_back( slots[ SlotIndex( age ) ] );
	for( int age = keep; age < (int)slots.size(); ++age )
		glDeleteTextures( 1, &slots[ SlotIndex( age ) ].texture );
	while( (int)resized.size() < capacity )
		resized.push_back( { NewTexture(), 0.0 } );
	slots  = std::move( resized );
	filled = keep;
	head   = keep - 1;
}

void FrameHistory::Push( const FFGLTextureStruct& input, GLuint hostFBO, double time )
{
	if( slots.empty() || !fbo )
		return;
	head              = ( head + 1 ) % (int)slots.size();
	filled            = std::min( filled + 1, (int)slots.size() );
	slots[ head ].time = time;

	GLint viewport[ 4 ];
	glGetIntegerv( GL_VIEWPORT, viewport );
	{
		ScopedFBOBinding fboBinding( fbo, ScopedFBOBinding::RB_REVERT );
		glFramebufferTexture2D( GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, slots[ head ].texture, 0 );
		glViewport( 0, 0, width, height );

		ScopedShaderBinding shaderBinding( copyShader.GetGLID() );
		ScopedSamplerActivation activateSampler( 0 );
		Scoped2DTextureBinding textureBinding( input.Handle );
		FFGLTexCoords maxCoords = GetMaxGLTexCoords( input );
		copyShader.Set( "inputTexture", 0 );
		copyShader.Set( "maxUV", maxCoords.s, maxCoords.t );
		quad.Draw();
		glFramebufferTexture2D( GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, 0, 0 );
	}
	// RB_REVERT rebinds whatever was bound before; make sure that is the host's target.
	glBindFramebuffer( GL_FRAMEBUFFER, hostFBO );
	glViewport( viewport[ 0 ], viewport[ 1 ], viewport[ 2 ], viewport[ 3 ] );
}

GLuint FrameHistory::Frame( int age ) const
{
	if( filled == 0 )
		return 0;
	return slots[ SlotIndex( std::clamp( age, 0, filled - 1 ) ) ].texture;
}

GLuint FrameHistory::FrameAt( double time ) const
{
	if( filled == 0 )
		return 0;
	// Times only go back as age grows: binary search for the youngest frame at or before `time`.
	int lo = 0, hi = filled - 1;
	if( slots[ SlotIndex( hi ) ].time > time )
		return slots[ SlotIndex( hi ) ].texture;
	while( lo < hi )
	{
		int mid = ( lo + hi ) / 2;
		if( slots[ SlotIndex( mid ) ].time <= time )
			hi = mid;
		else
			lo = mid + 1;
	}
	return slots[ SlotIndex( lo ) ].texture;
}
}// namespace stilletchaser
