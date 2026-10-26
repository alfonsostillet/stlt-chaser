#pragma once
#include <FFGLSDK.h>
#include <chrono>
#include <memory>
#include <vector>
#include "ChaseDocument.h"
#include "FrameHistory.h"
#include "PluginCommon.h"

// The all-in-one Stilletchaser effect.
// Driver decides which slices are lit (Chaser: a sequence stepped by the Step parameter,
// which Resolume animates with BPM sync, the timeline or FFT; None: every slice of the view).
// Modules add to it; the Delayer shows each slice's content some time ago.
class Stilletchaser : public stilletchaser::StilletchaserPlugin
{
public:
	Stilletchaser();

	FFResult InitGL( const FFGLViewportStruct* vp ) override;
	FFResult ProcessOpenGL( ProcessOpenGLStruct* pGL ) override;
	FFResult DeInitGL() override;

	FFResult SetFloatParameter( unsigned int index, float value ) override;
	float GetFloatParameter( unsigned int index ) override;
	char* GetParameterDisplay( unsigned int index ) override;

	const char* GetShortName() override
	{
		static const char* sname = "StChase";
		return sname;
	}

private:
	struct SliceDraw
	{
		GLint first;
		GLsizei count;
		GLuint texture;
		bool fromHistory;
	};

	void RefreshMenus( bool raiseEvents );
	void UpdateVisibility( bool raiseEvents );
	// Opacity of every slice for the current step position.
	void ComputeLevels( const stilletchaser::ChaseDocument& doc, std::vector< float >& levels ) const;
	// How long ago each slice's content comes from: frames with the Frames unit, seconds otherwise.
	void ComputeDelays( const stilletchaser::ChaseDocument& doc, std::vector< float >& delays ) const;
	bool DelayInFrames() const;
	// The full delay (Delay = 100%), in frames or seconds like ComputeDelays.
	float MaxDelay() const;
	void UpdateHistory( const FFGLTextureStruct& input, GLuint hostFBO );
	void BuildVertices( const stilletchaser::ChaseDocument& doc, const std::vector< float >& levels, const std::vector< float >& delays, const FFGLTextureStruct& input );

	ffglex::FFGLShader shader;
	GLuint vao = 0, vbo = 0;
	std::vector< float > vertices;
	std::vector< SliceDraw > draws;
	stilletchaser::FrameHistory history;

	std::shared_ptr< const stilletchaser::ChaseDocument > doc;
	uint64_t docVersion = 0;

	// Timing, for the Delayer's seconds and beats and its auto reset.
	std::chrono::steady_clock::time_point lastFrame;
	bool hasLastFrame     = false;
	float framesPerSecond = 60.f;
	double frameTime      = 0.0;// Seconds; when the current frame arrived.

	// Chaser
	float driver   = 0.f;
	float sequence = 0.f;
	float step     = 0.f;
	float scaling  = 1.f;
	float view     = 0.f;
	float echoes   = 0.f;
	float envelope = 0.f;
	float sustain  = 0.2f;
	float release  = 0.8f;

	// Delayer
	float delayer       = 0.f;
	float delaySequence = 0.f;
	float delay         = 1.f;
	float delayUnit     = 2.f;
	float maxFrames     = 30.f;
	float maxSeconds    = 1.f;
	float maxBeats      = 2.f;
	float quality       = 0.75f;
	float reverse       = 0.f;
	float autoReset     = 1.f;
	float resetMinutes  = 5.f;
};
