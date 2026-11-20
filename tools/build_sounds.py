"""Generate the game's sound effects as 16-bit mono WAV files.

Everything is synthesised with numpy, so there are no licensing questions and
the files can be rebuilt at any time:

    py -3.13 tools/build_sounds.py

Pygame Zero picks these up automatically through the `sounds` object:
`sounds.coin_pickup` plays sounds/coin_pickup.wav, and so on.
"""

import os
import random
import wave

import numpy as np

RATE = 22050
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOUNDS_DIR = os.path.join(PROJECT_ROOT, "sounds")


def envelope(samples, attack=0.006, decay=3.0):
    """Short fade-in plus an exponential fade-out; stops clicks at the edges."""
    count = len(samples)
    shape = np.exp(-decay * np.linspace(0.0, 1.0, count))
    attack_n = max(1, int(RATE * attack))
    shape[:attack_n] *= np.linspace(0.0, 1.0, attack_n)
    return samples * shape


def osc(freq, seconds, kind="square"):
    """One steady note."""
    t = np.linspace(0.0, seconds, int(RATE * seconds), endpoint=False)
    phase = 2.0 * np.pi * freq * t
    if kind == "square":
        return np.sign(np.sin(phase))
    if kind == "triangle":
        return 2.0 / np.pi * np.arcsin(np.sin(phase))
    return np.sin(phase)


def sweep(start_freq, end_freq, seconds, kind="sine"):
    """A note that glides from one pitch to another (used for jumping)."""
    count = int(RATE * seconds)
    freqs = np.linspace(start_freq, end_freq, count)
    phase = 2.0 * np.pi * np.cumsum(freqs) / RATE
    if kind == "square":
        return np.sign(np.sin(phase))
    return np.sin(phase)


def sequence(notes, volume=0.55):
    """Play (frequency, length) pairs one after another in a single buffer."""
    pieces = []
    for freq, seconds in notes:
        pieces.append(envelope(osc(freq, seconds), decay=3.5) * volume)
    return np.concatenate(pieces)


def mix(*tracks):
    length = max(len(track) for track in tracks)
    buffer = np.zeros(length)
    for track in tracks:
        buffer[: len(track)] += track
    return buffer


def save(name, samples):
    peak = np.max(np.abs(samples)) or 1.0
    samples = samples / peak * 0.85
    pcm = (samples * 32767).astype(np.int16)

    with wave.open(os.path.join(SOUNDS_DIR, name + ".wav"), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(RATE)
        handle.writeframes(pcm.tobytes())
    print(f"{name}.wav  {len(samples) / RATE:.2f}s")


def main():
    os.makedirs(SOUNDS_DIR, exist_ok=True)

    # Two bright notes: pocketing a coin.
    save("coin_pickup", sequence([(1046, 0.05), (1568, 0.11)]))

    # Rising chirp when the player leaves the ground.
    jump = envelope(sweep(320, 760, 0.14), decay=2.5) * 0.5
    save("jump", jump)

    # Falling buzz plus a splash of noise: hitting the spikes.
    fall = sweep(220, 70, 0.26, kind="square")
    rng = random.Random(7)
    noise = np.array([rng.uniform(-1.0, 1.0) for _ in range(len(fall))])
    save("hurt", mix(envelope(fall, decay=2.0) * 0.45, envelope(noise, decay=6.0) * 0.12))

    # Slow descending minor arpeggio: the run is over.
    save("game_over", sequence([(392, 0.18), (330, 0.18), (262, 0.18), (175, 0.34)]))

    # Ascending fanfare for a new personal best.
    save("new_best", sequence([(523, 0.10), (659, 0.10), (784, 0.10), (1047, 0.24)]))

    # Short two-note rise when the tower gets harder.
    save("level_up", sequence([(587, 0.09), (880, 0.16)]))


if __name__ == "__main__":
    main()
