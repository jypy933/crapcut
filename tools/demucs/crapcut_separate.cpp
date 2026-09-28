// CrapCut's voice separator: runs Demucs (via demucs.cpp) on one clip and
// writes two files, the voice and everything else.
//
//   crapcut-separate <model.bin> <input.wav> <voice.wav> <background.wav> <threads>
//
// Input must be a 44.1 kHz WAV. Progress lines look like
// "[THREAD 0] ( 45.000%) ..." (from demucs.cpp's threaded inference).
// Based on demucs.cpp's cli-apps/demucs_mt.cpp (MIT, Sevag H).

#include "dsp.hpp"
#include "model.hpp"
#include "tensor.hpp"
#include "threaded_inference.hpp"
#include <Eigen/Core>
#include <Eigen/Dense>
#include <iostream>
#include <libnyquist/Common.h>
#include <libnyquist/Decoders.h>
#include <libnyquist/Encoders.h>
#include <memory>
#include <string>

using namespace nqr;

static bool load_audio(const std::string &file, Eigen::MatrixXf &out)
{
    auto data = std::make_shared<AudioData>();
    NyquistIO loader;
    loader.Load(data.get(), file);
    if (data->sampleRate != demucscpp::SUPPORTED_SAMPLE_RATE)
    {
        std::cerr << "[ERROR] input must be 44100 Hz" << std::endl;
        return false;
    }
    const size_t n = data->samples.size() / data->channelCount;
    out.resize(2, n);
    for (size_t i = 0; i < n; ++i)
    {
        if (data->channelCount == 1)
        {
            out(0, i) = data->samples[i];
            out(1, i) = data->samples[i];
        }
        else
        {
            out(0, i) = data->samples[i * data->channelCount];
            out(1, i) = data->samples[i * data->channelCount + 1];
        }
    }
    return true;
}

static int write_audio(const Eigen::MatrixXf &wave, const std::string &file)
{
    auto data = std::make_shared<AudioData>();
    data->sampleRate = demucscpp::SUPPORTED_SAMPLE_RATE;
    data->channelCount = 2;
    data->samples.resize(wave.cols() * 2);
    for (long i = 0; i < wave.cols(); ++i)
    {
        data->samples[2 * i] = wave(0, i);
        data->samples[2 * i + 1] = wave(1, i);
    }
    return encode_wav_to_disk({2, PCM_FLT, DITHER_NONE}, data.get(), file);
}

int main(int argc, const char **argv)
{
    if (argc != 6)
    {
        std::cerr << "Usage: " << argv[0] << " <model> <input.wav> <voice.wav> <background.wav> <threads>" << std::endl;
        return 2;
    }
    const std::string model_file = argv[1];
    const std::string input = argv[2];
    const std::string voice_out = argv[3];
    const std::string background_out = argv[4];
    int threads = std::max(1, std::min(32, std::atoi(argv[5])));

    Eigen::MatrixXf audio;
    if (!load_audio(input, audio))
        return 3;

    demucscpp::demucs_model model{};
    if (!demucscpp::load_demucs_model(model_file, &model))
    {
        std::cerr << "[ERROR] could not load model" << std::endl;
        return 4;
    }
    if (!model.is_4sources)
    {
        std::cerr << "[ERROR] a 4-source model is required" << std::endl;
        return 5;
    }

    Eigen::Tensor3dXf targets = demucscppthreaded::threaded_inference(model, audio, threads);

    // Target 3 is vocals; the background is the mix minus the voice so nothing is lost.
    Eigen::MatrixXf voice(2, audio.cols());
    Eigen::MatrixXf background(2, audio.cols());
    for (int c = 0; c < 2; ++c)
    {
        for (long s = 0; s < audio.cols(); ++s)
        {
            voice(c, s) = targets(3, c, s);
            background(c, s) = audio(c, s) - targets(3, c, s);
        }
    }
    if (write_audio(voice, voice_out) != 0 || write_audio(background, background_out) != 0)
    {
        std::cerr << "[ERROR] could not write output" << std::endl;
        return 6;
    }
    std::cout << "[DONE]" << std::endl;
    return 0;
}
