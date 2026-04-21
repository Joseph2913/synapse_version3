"""
Generate minimal, clean UI sound effects for Synapse Remotion videos.

Produces:
  - node-pop.wav      — short, soft digital pop for node/entity appearance
  - connection.wav    — resonant chime for edge connections being made
  - whoosh.wav        — gentle forward swoosh for timeline/transition
  - burst.wav         — layered chime cluster for the "connection burst" moment
  - ambient-pad.wav   — warm, gently uplifting pad (major-key, subtle)
  - typing-click.wav  — soft keystroke click for chat typing

All sounds are designed to feel: clean, digital, confident, minimal.
Not cartoonish, not dramatic — like a premium instrument interface.
"""

import wave
import struct
import math
import os
import random

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "remotion", "public", "audio")
SAMPLE_RATE = 44100


def write_wav(filename: str, samples: list[float], channels: int = 1):
    """Write float samples (-1.0 to 1.0) to a WAV file."""
    path = os.path.join(OUTPUT_DIR, filename)
    with wave.open(path, "w") as f:
        f.setnchannels(channels)
        f.setsampwidth(2)  # 16-bit
        f.setframerate(SAMPLE_RATE)
        for s in samples:
            clamped = max(-1.0, min(1.0, s))
            f.writeframes(struct.pack("<h", int(clamped * 32767)))
    print(f"  ✓ {filename} ({len(samples)/SAMPLE_RATE:.2f}s)")


def sine(freq: float, t: float) -> float:
    return math.sin(2 * math.pi * freq * t)


def envelope_exp(t: float, attack: float, decay: float, duration: float) -> float:
    """Attack-decay envelope with exponential falloff."""
    if t < attack:
        return t / attack
    remaining = t - attack
    decay_time = duration - attack
    if decay_time <= 0:
        return 0
    return math.exp(-remaining / decay)


def generate_node_pop():
    """Short, soft pop — like a digital droplet. ~0.15s"""
    duration = 0.15
    samples = []
    for i in range(int(SAMPLE_RATE * duration)):
        t = i / SAMPLE_RATE
        freq = 1200 - 800 * (t / duration)
        env = envelope_exp(t, 0.005, 0.08, duration)
        val = sine(freq, t) * 0.7 + sine(freq * 2, t) * 0.15
        samples.append(val * env * 0.6)
    write_wav("node-pop.wav", samples)


def generate_connection():
    """Resonant chime — two harmonics ringing together. ~0.4s"""
    duration = 0.4
    samples = []
    for i in range(int(SAMPLE_RATE * duration)):
        t = i / SAMPLE_RATE
        env = envelope_exp(t, 0.008, 0.15, duration)
        val = sine(880, t) * 0.5 + sine(1320, t) * 0.3 + sine(1760, t) * 0.1
        samples.append(val * env * 0.45)
    write_wav("connection.wav", samples)


def generate_whoosh():
    """Gentle forward swoosh — filtered noise sweep. ~0.5s"""
    duration = 0.5
    random.seed(42)
    samples = []
    for i in range(int(SAMPLE_RATE * duration)):
        t = i / SAMPLE_RATE
        progress = t / duration
        if progress < 0.4:
            env = progress / 0.4
        else:
            env = 1.0 - ((progress - 0.4) / 0.6)
        env = env ** 0.5
        noise = random.uniform(-1, 1)
        center = 400 + 1200 * progress
        mod = sine(center, t) * 0.3 + sine(center * 1.5, t) * 0.15
        val = noise * 0.4 + mod * 0.3
        samples.append(val * env * 0.35)
    write_wav("whoosh.wav", samples)


def generate_burst():
    """Layered chime cluster — multiple connection chimes offset. ~0.8s"""
    duration = 0.8
    chimes = [
        (0.00, 880, 0.40),
        (0.05, 1047, 0.35),
        (0.10, 1175, 0.30),
        (0.18, 1320, 0.30),
        (0.25, 1568, 0.25),
    ]
    samples = []
    for i in range(int(SAMPLE_RATE * duration)):
        t = i / SAMPLE_RATE
        val = 0.0
        for onset, freq, amp in chimes:
            if t >= onset:
                local_t = t - onset
                local_dur = duration - onset
                env = envelope_exp(local_t, 0.005, 0.12, local_dur)
                val += sine(freq, local_t) * env * amp
                val += sine(freq * 2, local_t) * env * amp * 0.15
        samples.append(val * 0.35)
    write_wav("burst.wav", samples)


def generate_ambient_pad():
    """
    Warm, gently uplifting ambient pad — major-key, airy, subtle.
    Uses a C major chord (C4-E4-G4) with soft detuning and slow LFO.
    8 seconds, loop-friendly. Very quiet — sits behind everything.
    """
    duration = 8.0
    samples = []

    # C major chord frequencies with gentle detuning
    # C4=261.63, E4=329.63, G4=392.00, C5=523.25 (octave for shimmer)
    voices = [
        (261.63, 0.30),  # C4 — root
        (329.63, 0.22),  # E4 — major third (warmth)
        (392.00, 0.20),  # G4 — fifth (stability)
        (523.25, 0.10),  # C5 — octave shimmer
    ]

    for i in range(int(SAMPLE_RATE * duration)):
        t = i / SAMPLE_RATE

        # Fade in 2s, hold, fade out 2s (loop-friendly crossfade)
        if t < 2.0:
            env = t / 2.0
        elif t > duration - 2.0:
            env = (duration - t) / 2.0
        else:
            env = 1.0
        # Smooth the envelope
        env = env * env * (3 - 2 * env)  # smoothstep

        val = 0.0
        for freq, amp in voices:
            # Slow LFO for gentle movement (different rate per voice)
            lfo = 1.0 + 0.003 * sine(0.15 + freq * 0.0001, t)
            # Slight detuning for warmth
            detune = 1.0 + 0.001 * sine(0.07, t + freq)
            val += sine(freq * lfo * detune, t) * amp
            # Add a soft harmonic for airiness
            val += sine(freq * 2 * lfo, t) * amp * 0.05

        samples.append(val * env * 0.12)  # Very quiet

    write_wav("ambient-pad.wav", samples)


def generate_typing_click():
    """Soft keystroke click — very short, like a mechanical keyboard tap. ~0.05s"""
    duration = 0.05
    random.seed(99)
    samples = []
    for i in range(int(SAMPLE_RATE * duration)):
        t = i / SAMPLE_RATE
        # Very fast attack, quick decay
        env = envelope_exp(t, 0.001, 0.015, duration)
        # Mix of noise (click character) + high sine (tap tone)
        noise = random.uniform(-1, 1) * 0.5
        tone = sine(3500, t) * 0.3 + sine(5000, t) * 0.1
        val = (noise + tone) * env
        samples.append(val * 0.5)
    write_wav("typing-click.wav", samples)


if __name__ == "__main__":
    print("Generating Synapse sound effects...")
    generate_node_pop()
    generate_connection()
    generate_whoosh()
    generate_burst()
    generate_ambient_pad()
    generate_typing_click()
    print("Done!")
