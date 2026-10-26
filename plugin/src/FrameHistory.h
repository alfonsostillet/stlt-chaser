#pragma once
#include <FFGLSDK.h>
#include <vector>

namespace stilletchaser
{
// The last N frames of the input, kept in GPU textures (a ring buffer) so slices can show
// the content as it was some time ago. Stored at `quality` of the input size to save VRAM.
// Every frame remembers when it arrived, so delays in seconds pick frames by time,
// independent of how steady the frame rate is.
class FrameHistory
{
public:
	bool InitGL();
	void DeInitGL();

	// Makes room for `capacity` frames of `width` x `height`. Growing or shrinking keeps the
	// newest frames; only a new frame size starts the history over.
	void Configure( int capacity, int width, int height );
	// Copies the input in as the newest frame, taken at `time` (seconds, any steady clock).
	// Restores the host's framebuffer and viewport.
	void Push( const FFGLTextureStruct& input, GLuint hostFBO, double time );
	// Forgets the stored frames (the next Push starts a fresh history).
	void Clear()
	{
		filled = 0;
	}

	// The frame from `age` frames ago (0 = newest), limited to what has been stored so far.
	GLuint Frame( int age ) const;
	// The newest frame taken at or before `time`; the oldest stored one if all are newer.
	GLuint FrameAt( double time ) const;
	int Filled() const
	{
		return filled;
	}
	int Capacity() const
	{
		return (int)slots.size();
	}

private:
	struct Slot
	{
		GLuint texture;
		double time;
	};
	void Release();
	GLuint NewTexture() const;
	int SlotIndex( int age ) const
	{
		return ( head - age + (int)slots.size() ) % (int)slots.size();
	}

	ffglex::FFGLShader copyShader;
	ffglex::FFGLScreenQuad quad;
	GLuint fbo = 0;
	std::vector< Slot > slots;
	int width = 0, height = 0;
	int head   = -1;
	int filled = 0;
};
}// namespace stilletchaser
