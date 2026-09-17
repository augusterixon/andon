// One-time generator for a soft sine-wave "pluck" notification sound.
// Run with: node generate-pluck.js
// Produces assets/sound-1.wav — a short, smooth tone with a natural decay envelope.

const fs = require('fs');
const path = require('path');

const SAMPLE_RATE = 44100;
const DURATION_S = 0.6;
const FREQ_HZ = 196; // G3 — low, warm, sits below "alert" territory entirely
const NUM_SAMPLES = Math.floor(SAMPLE_RATE * DURATION_S);

const samples = new Int16Array(NUM_SAMPLES);

for (let i = 0; i < NUM_SAMPLES; i++) {
  const t = i / SAMPLE_RATE;

  // Slower decay than a "ping" — this is a soft mallet-on-wood feel, not an alert
  const envelope = Math.exp(-4 * t);

  // A quiet sub-octave underneath the fundamental adds warmth/weight without
  // adding any brightness. A very soft, slightly-detuned unison (not an
  // octave-up overtone) gives it a gentle chorus-like softness instead of
  // the harder "beep" character an upper harmonic creates.
  const fundamental = Math.sin(2 * Math.PI * FREQ_HZ * t);
  const subOctave = 0.3 * Math.sin(2 * Math.PI * (FREQ_HZ / 2) * t);
  const softDetune = 0.15 * Math.sin(2 * Math.PI * (FREQ_HZ * 1.003) * t);

  // Gentle fade-in avoids a click at the start, gentle fade-out avoids one at the end
  const fadeIn = Math.min(1, t / 0.008);
  const fadeOut = Math.min(1, (DURATION_S - t) / 0.05);

  const value = (fundamental + subOctave + softDetune) * envelope * fadeIn * fadeOut * 0.28; // low headroom = mellow, unobtrusive volume
  samples[i] = Math.max(-32767, Math.min(32767, Math.round(value * 32767)));
}

// --- Minimal WAV file writer (PCM, mono, 16-bit) ---
const byteRate = SAMPLE_RATE * 2;
const dataSize = samples.length * 2;
const buffer = Buffer.alloc(44 + dataSize);

buffer.write('RIFF', 0);
buffer.writeUInt32LE(36 + dataSize, 4);
buffer.write('WAVE', 8);
buffer.write('fmt ', 12);
buffer.writeUInt32LE(16, 16); // PCM chunk size
buffer.writeUInt16LE(1, 20); // audio format = PCM
buffer.writeUInt16LE(1, 22); // channels = mono
buffer.writeUInt32LE(SAMPLE_RATE, 24);
buffer.writeUInt32LE(byteRate, 28);
buffer.writeUInt16LE(2, 32); // block align
buffer.writeUInt16LE(16, 34); // bits per sample
buffer.write('data', 36);
buffer.writeUInt32LE(dataSize, 40);

for (let i = 0; i < samples.length; i++) {
  buffer.writeInt16LE(samples[i], 44 + i * 2);
}

const outDir = path.join(__dirname, 'assets');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'sound-1.wav'), buffer);
console.log('Wrote assets/sound-1.wav');
