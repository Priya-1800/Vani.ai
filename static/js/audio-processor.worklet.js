class AudioProcessor extends AudioWorkletProcessor {
    process(inputs, outputs, parameters) {
        const input = inputs[0];
        if (input.length > 0) {
            const channelData = input[0];
            const int16 = new Int16Array(channelData.length);
            for (let i = 0; i < channelData.length; i++) {
                let s = Math.max(-1, Math.min(1, channelData[i]));
                int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
            this.port.postMessage({ audioData: int16.buffer }, [int16.buffer]);
        }
        return true;
    }
}

registerProcessor('audio-processor', AudioProcessor);
