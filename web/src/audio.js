/* =====================================================================
   NEON STRIKE — 音效引擎
   全部使用 WebAudio 实时合成，不依赖任何外部音频文件。
   ===================================================================== */
window.FPS = window.FPS || {};

(function () {
  'use strict';

  var ctx = null;
  var master = null;
  var noiseBuf = null;
  var muted = false;
  var volume = 1;          // 0..1，由设置界面控制
  var ready = false;

  function applyGain() {
    if (master) master.gain.value = muted ? 0 : 0.55 * volume;
  }

  function makeNoiseBuffer(ac) {
    var len = Math.floor(ac.sampleRate * 1.2);
    var buf = ac.createBuffer(1, len, ac.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  function init() {
    if (ready) return true;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try {
      ctx = new AC();
    } catch (e) {
      return false;
    }
    master = ctx.createGain();
    applyGain();

    // 轻微压缩，避免连续开火时爆音
    var comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 24;
    comp.ratio.value = 8;
    comp.attack.value = 0.003;
    comp.release.value = 0.22;

    master.connect(comp);
    comp.connect(ctx.destination);

    noiseBuf = makeNoiseBuffer(ctx);
    ready = true;
    return true;
  }

  function resume() {
    if (!ready && !init()) return;
    if (ctx.state === 'suspended') ctx.resume();
  }

  function setMuted(v) {
    muted = !!v;
    applyGain();
  }

  /** 音量 0..1（设置界面用） */
  function setVolume(v) {
    volume = Math.max(0, Math.min(1, isFinite(v) ? v : 1));
    applyGain();
  }

  function t0() { return ctx.currentTime; }

  /* ---------- 基础音源 ---------- */

  // 噪声脉冲（低频扫频滤波）——用于枪声、脚步、撞击
  function noiseHit(opt) {
    if (!ready || muted) return;
    var t = t0() + (opt.delay || 0);
    var dur = opt.dur || 0.15;

    var src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.playbackRate.value = opt.rate || 1;
    src.loop = true;

    var filter = ctx.createBiquadFilter();
    filter.type = opt.filterType || 'lowpass';
    filter.frequency.setValueAtTime(opt.freq || 2600, t);
    filter.frequency.exponentialRampToValueAtTime(Math.max(60, opt.freqEnd || 320), t + dur);
    filter.Q.value = opt.q || 1;

    var g = ctx.createGain();
    var peak = (opt.gain == null ? 0.5 : opt.gain);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + (opt.attack || 0.004));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    src.connect(filter); filter.connect(g); g.connect(master);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  // 振荡器音调（可扫频）——用于提示音、死亡音、受伤音
  function tone(opt) {
    if (!ready || muted) return;
    var t = t0() + (opt.delay || 0);
    var dur = opt.dur || 0.12;

    var osc = ctx.createOscillator();
    osc.type = opt.type || 'sine';
    var f0 = opt.freq || 440;
    var f1 = opt.freqEnd == null ? f0 : opt.freqEnd;
    osc.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);

    var g = ctx.createGain();
    var peak = (opt.gain == null ? 0.22 : opt.gain);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + (opt.attack || 0.008));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    osc.connect(g); g.connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  /* ---------- 对外音效 ---------- */
  var api = {
    get ready() { return ready; },
    get muted() { return muted; },
    get volume() { return volume; },

    init: init,
    resume: resume,
    setMuted: setMuted,
    setVolume: setVolume,
    toggleMute: function () { setMuted(!muted); return muted; },

    // 开火：爆裂噪声 + 低频推力
    shot: function () {
      noiseHit({ dur: 0.13, freq: 5200, freqEnd: 260, gain: 0.5, rate: 1.25, attack: 0.002 });
      noiseHit({ dur: 0.035, freq: 9000, freqEnd: 3000, gain: 0.28, filterType: 'highpass', rate: 1.6 });
      tone({ type: 'triangle', freq: 150, freqEnd: 46, dur: 0.13, gain: 0.3 });
    },

    // 空仓
    empty: function () {
      noiseHit({ dur: 0.03, freq: 4200, freqEnd: 2200, gain: 0.24, filterType: 'highpass' });
      tone({ type: 'square', freq: 900, freqEnd: 600, dur: 0.05, gain: 0.07 });
    },

    // 换弹：卸弹匣 / 上膛
    reloadOut: function () {
      noiseHit({ dur: 0.07, freq: 2800, freqEnd: 900, gain: 0.24, filterType: 'bandpass', q: 1.4 });
      tone({ type: 'square', freq: 240, freqEnd: 150, dur: 0.07, gain: 0.1 });
    },
    reloadIn: function (delay) {
      noiseHit({ dur: 0.08, freq: 3600, freqEnd: 1100, gain: 0.28, filterType: 'bandpass', q: 1.6, delay: delay || 0 });
      tone({ type: 'square', freq: 320, freqEnd: 180, dur: 0.08, gain: 0.12, delay: delay || 0 });
    },

    // 举镜 / 收镜：金属轻响
    scopeIn: function () {
      noiseHit({ dur: 0.05, freq: 5200, freqEnd: 2400, gain: 0.16, filterType: 'bandpass', q: 2.2 });
      tone({ type: 'square', freq: 1250, freqEnd: 900, dur: 0.04, gain: 0.05 });
    },
    scopeOut: function () {
      noiseHit({ dur: 0.06, freq: 3200, freqEnd: 1400, gain: 0.13, filterType: 'bandpass', q: 1.8 });
      tone({ type: 'square', freq: 760, freqEnd: 520, dur: 0.05, gain: 0.04 });
    },

    // 拍弹匣底：闷响
    magTap: function (delay) {
      noiseHit({ dur: 0.06, freq: 1500, freqEnd: 420, gain: 0.22, filterType: 'lowpass', delay: delay || 0 });
      tone({ type: 'triangle', freq: 190, freqEnd: 96, dur: 0.07, gain: 0.12, delay: delay || 0 });
    },

    // 命中反馈
    hit: function () {
      tone({ type: 'square', freq: 1500, freqEnd: 1100, dur: 0.05, gain: 0.12 });
    },
    headshot: function () {
      tone({ type: 'square', freq: 2300, freqEnd: 1500, dur: 0.07, gain: 0.14 });
      tone({ type: 'triangle', freq: 3200, dur: 0.05, gain: 0.08, delay: 0.03 });
    },

    // 敌人被击杀
    kill: function () {
      tone({ type: 'sawtooth', freq: 420, freqEnd: 70, dur: 0.42, gain: 0.24 });
      noiseHit({ dur: 0.3, freq: 2200, freqEnd: 180, gain: 0.3 });
    },

    // 敌人发现玩家
    alert: function () {
      tone({ type: 'sawtooth', freq: 200, freqEnd: 430, dur: 0.18, gain: 0.15 });
      tone({ type: 'sawtooth', freq: 300, freqEnd: 640, dur: 0.16, gain: 0.12, delay: 0.19 });
    },

    // 玩家受伤
    hurt: function () {
      tone({ type: 'sine', freq: 170, freqEnd: 62, dur: 0.26, gain: 0.34 });
      noiseHit({ dur: 0.22, freq: 900, freqEnd: 120, gain: 0.28 });
    },

    // 脚步
    step: function (alt) {
      noiseHit({
        dur: 0.055, freq: alt ? 1500 : 1150, freqEnd: 300, gain: 0.11,
        filterType: 'lowpass', rate: alt ? 1.15 : 0.95
      });
    },

    // 拾取 / 治疗
    heal: function () {
      tone({ type: 'sine', freq: 620, freqEnd: 980, dur: 0.2, gain: 0.2 });
      tone({ type: 'sine', freq: 940, freqEnd: 1400, dur: 0.18, gain: 0.14, delay: 0.11 });
    },

    // 波次开始
    waveStart: function () {
      tone({ type: 'triangle', freq: 420, dur: 0.16, gain: 0.2 });
      tone({ type: 'triangle', freq: 640, dur: 0.22, gain: 0.2, delay: 0.17 });
    },

    // 波次清空
    waveClear: function () {
      [520, 660, 880, 1180].forEach(function (f, i) {
        tone({ type: 'triangle', freq: f, dur: 0.2, gain: 0.18, delay: i * 0.1 });
      });
    },

    // 游戏结束
    gameOver: function () {
      [440, 350, 260, 150].forEach(function (f, i) {
        tone({ type: 'sawtooth', freq: f, freqEnd: f * 0.6, dur: 0.4, gain: 0.2, delay: i * 0.19 });
      });
    },

    // 界面点击
    ui: function () {
      tone({ type: 'square', freq: 720, freqEnd: 1080, dur: 0.06, gain: 0.1 });
    }
  };

  FPS.Sfx = api;
})();
