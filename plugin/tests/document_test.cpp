// Checks the document loader against files the editor wrote:
//   document_test <current.stchase> <envelopes.json>
#include <cstdio>
#include <cmath>
#include "ChaseDocument.h"

using namespace stilletchaser;

static int failures = 0;
#define CHECK( cond )                                                    \
	do                                                                   \
	{                                                                    \
		if( !( cond ) )                                                  \
		{                                                                \
			std::printf( "FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond ); \
			++failures;                                                  \
		}                                                                \
	} while( 0 )

int main( int argc, char** argv )
{
	CHECK( SustainRelease( 0.2f, 0.8f, 0.1f ) == 1.f );
	CHECK( std::fabs( SustainRelease( 0.2f, 0.8f, 0.5f ) - 0.5f ) < 1e-5f );
	CHECK( SustainRelease( 0.2f, 0.8f, 0.9f ) == 0.f );
	CHECK( SustainRelease( 1.f, 1.f, 0.99f ) == 1.f );
	std::array< float, 256 > ramp;
	for( int i = 0; i < 256; ++i )
		ramp[ i ] = i / 255.f;
	CHECK( std::fabs( SampleLut( ramp, 0.5f ) - 0.5f ) < 1e-4f );

	auto missing = LoadChaseDocument( "does-not-exist.stchase", "nope.json" );
	CHECK( !missing->error.empty() && missing->slices.empty() );

	if( argc < 3 )
	{
		std::printf( "%s\n", failures ? "FAILED" : "ok (no document given)" );
		return failures;
	}
	auto doc = LoadChaseDocument( argv[ 1 ], argv[ 2 ] );
	std::printf( "error: '%s'\ncomp %.0fx%.0f, %zu slices, %zu sequences, %zu views, %zu envelopes\n", doc->error.c_str(), doc->compWidth, doc->compHeight,
				 doc->slices.size(), doc->sequences.size(), doc->views.size(), doc->envelopes.size() );
	CHECK( doc->error.empty() );
	CHECK( !doc->slices.empty() );
	CHECK( doc->views.size() >= 1 && doc->views[ 0 ].name == "All" );
	for( const Slice& s : doc->slices )
	{
		CHECK( s.indices.size() == ( s.points.size() - 2 ) * 3 );
		std::printf( "  %-10s %zu pts, frame (%.3f,%.3f) x(%.3f,%.3f) y(%.3f,%.3f)\n", s.name.c_str(), s.points.size(), s.origin.x, s.origin.y, s.axisX.x,
					 s.axisX.y, s.axisY.x, s.axisY.y );
	}
	for( const Sequence& q : doc->sequences )
	{
		std::printf( "  %s: %zu steps, first step lights %zu\n", q.name.c_str(), q.steps.size(), q.steps[ 0 ].size() );
	}
	std::printf( "%s\n", failures ? "FAILED" : "ok" );
	return failures;
}
