'use strict';

const test = require('node:test');
const assert = require('node:assert');

const audio = require('../audio');

test('the wav header is a valid 44-byte canonical PCM header', function () {
  // rtl_fm emits signed 16-bit little-endian mono, which IS wav payload -- so the whole conversion
  // is 44 bytes of prefix. If any of these offsets drift, the file opens as noise or not at all,
  // and you find out on your laptop after the recording is over and the radio has moved on.
  const rate = 48000;
  const data = 96000;                       // 1 second
  const h = audio.wav_header(rate, data);

  assert.equal(h.length, 44);
  assert.equal(h.toString('ascii', 0, 4), 'RIFF');
  assert.equal(h.readUInt32LE(4), 36 + data, 'RIFF size is 36 + payload, not the file length');
  assert.equal(h.toString('ascii', 8, 12), 'WAVE');
  assert.equal(h.toString('ascii', 12, 16), 'fmt ');
  assert.equal(h.readUInt32LE(16), 16, 'PCM fmt chunk is 16 bytes');
  assert.equal(h.readUInt16LE(20), 1, 'format 1 = uncompressed PCM');
  assert.equal(h.readUInt16LE(22), 1, 'mono');
  assert.equal(h.readUInt32LE(24), rate);
  assert.equal(h.readUInt32LE(28), rate * 2, 'byte rate = rate x 2 bytes per sample');
  assert.equal(h.readUInt16LE(32), 2, 'block align');
  assert.equal(h.readUInt16LE(34), 16, 'bit depth');
  assert.equal(h.toString('ascii', 36, 40), 'data');
  assert.equal(h.readUInt32LE(40), data);
});

test('a zero-length header is still well formed', function () {
  // Written first, before any samples arrive, then patched on close. If the radio never produces
  // anything the file must still be openable rather than truncated garbage.
  const h = audio.wav_header(12000, 0);
  assert.equal(h.readUInt32LE(4), 36);
  assert.equal(h.readUInt32LE(40), 0);
});

test('each mode sets a window matched to its signal', function () {
  // Same lesson as -s on rtl_433: the sample rate IS the bandwidth, so it is chosen to fit the
  // signal. An FM broadcast channel is ~200 kHz; AM voice is ~8 kHz of audio in a 12 kHz slot.
  assert.equal(audio.MODES.fm.sample_hz, 200000);
  assert.equal(audio.MODES.fm.mod, 'wbfm');
  assert.equal(audio.MODES.am.sample_hz, 12000);
  assert.equal(audio.MODES.am.mod, 'am');
  for (const key of Object.keys(audio.MODES)) {
    const m = audio.MODES[key];
    assert.ok(m.audio_hz <= m.sample_hz, key + ' cannot output more audio than it samples');
    assert.ok(m.default_mhz >= m.band[0] && m.default_mhz <= m.band[1],
      key + ' default must be inside the band it documents');
  }
});

test('the AM broadcast band is below the tuner floor and the code knows it', function () {
  // The trap the `am` mode exists to disarm: "AM" makes people type 850 and expect their local
  // talk station. An R820T starts around 24 MHz; 0.85 MHz needs a direct-sampling mod or an
  // upconverter, and no combination of flags substitutes for hardware.
  assert.ok(audio.TUNER_LOW_MHZ > 1.7, 'AM broadcast tops out at 1.7 MHz and must be below the floor');
  assert.ok(audio.MODES.am.band[0] >= audio.TUNER_LOW_MHZ,
    'the documented am band must be reachable by the tuner');
  assert.ok(audio.MODES.fm.band[0] >= audio.TUNER_LOW_MHZ);
  assert.ok(audio.MODES.fm.band[1] <= audio.TUNER_HIGH_MHZ);
});

test('the NOAA channel list is the real seven, at 25 kHz spacing', function () {
  // Every NWR transmitter in the US uses one of these and nothing else, so getting the list wrong
  // does not fail loudly -- it just means the one channel receivable at this house is not in it and
  // the mode looks broken.
  const ch = audio.NOAA_CHANNELS;
  assert.equal(ch.length, 7);
  assert.equal(ch[0], 162.400);
  assert.equal(ch[6], 162.550);
  for (let i = 1; i < ch.length; i += 1) {
    assert.ok(Math.abs((ch[i] - ch[i - 1]) - 0.025) < 1e-9,
      'NWR channels are spaced 25 kHz apart; got ' + (ch[i] - ch[i - 1]));
  }
});

test('weather and nfm are narrowband FM, not wideband and not AM', function () {
  // The whole reason this mode exists: `fm` (wbfm, 200 kHz) demodulates a 25 kHz NOAA signal as
  // faint hiss, and `am` is the wrong demodulator entirely. Getting this back to front produces
  // audio that sounds like bad reception rather than like a wrong setting.
  for (const key of ['nfm', 'weather']) {
    const m = audio.MODES[key];
    assert.equal(m.mod, 'fm', key + ' must use narrowband FM');
    assert.ok(m.sample_hz >= 25000 && m.sample_hz <= 50000,
      key + ' window must cover a 25 kHz channel without being wideband; got ' + m.sample_hz);
    assert.ok((m.extra || []).join(' ').includes('-E deemp'),
      key + ' needs de-emphasis or voice sounds thin and hissy');
  }
  assert.equal(audio.MODES.fm.mod, 'wbfm', 'broadcast FM stays wideband');
});

test('every NOAA channel sits inside the weather mode\'s documented band', function () {
  const m = audio.MODES.weather;
  for (const f of audio.NOAA_CHANNELS) {
    assert.ok(f >= m.band[0] && f <= m.band[1], f + ' is outside the documented band');
  }
  assert.ok(audio.NOAA_CHANNELS.includes(m.default_mhz), 'the default must be a real channel');
});
