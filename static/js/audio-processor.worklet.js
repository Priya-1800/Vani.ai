const TARGET_RATE = 16000;
const CHUNK_SAMPLES = 800; // 50 ms of audio per message

class AudioProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        // Never fight the browser over the AudioContext rate: capture at the
        // device rate and downsample here, otherwise the mic stream arrives
        // sped up and speech recognition hears gibberish.
        this.ratio = sampleRate / TARGET_RATE;
        this.pos = 0;
        this.buffer = new Float32Array(CHUNK_SAMPLES);
        this.filled = 0;
    }

    flush() {
        if (this.filled === 0) return;

        const int16 = new Int16Array(this.filled);
        for (let i = 0; i < this.filled; i++) {
            const s = Math.max(-1, Math.min(1, this.buffer[i]));
            int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        this.port.postMessage({ audioData: int16.buffer }, [int16.buffer]);
        this.filled = 0;
    }

    push(sample) {
        this.buffer[this.filled++] = sample;
        if (this.filled === CHUNK_SAMPLES) {
            this.flush();
        }
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        if (!input || input.length === 0 || !input[0]) {
            return true;
        }

        const channel = input[0];

        if (Math.abs(this.ratio - 1) < 1e-3) {
            for (let i = 0; i < channel.length; i++) {
                this.push(channel[i]);
            }
            return true;
        }

        // Box-average decimation: cheap, and smooth enough for speech.
        while (this.pos < channel.length) {
            const start = Math.floor(this.pos);
            const end = Math.min(Math.max(Math.floor(this.pos + this.ratio), start + 1), channel.length);

            let sum = 0;
            for (let i = start; i < end; i++) {
                sum += channel[i];
            }
            this.push(sum / (end - start));
            this.pos += this.ratio;
        }
        this.pos -= channel.length;

        return true;
    }
}

registerProcessor('audio-processor', AudioProcessor);
