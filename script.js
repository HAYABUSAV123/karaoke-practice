// ============================================================
// カラオケ練習ツール v3
// ・左右の音源が別々の再生位置を持つ（連動ON/OFF）
// ・波形をタップ/ドラッグして位置を動かす
// ・ループ設定を開いたときだけ、ピン付きループが使える
// ============================================================
 
// iPhoneの消音スイッチがONでも鳴らす
if (navigator.audioSession) navigator.audioSession.type = "playback";
 
const AudioCtx = window.AudioContext || window.webkitAudioContext;
const audioContext = new AudioCtx();
 
// 左耳・右耳に分けて出力するための合流ノード
const merger = audioContext.createChannelMerger(2);
merger.connect(audioContext.destination);
 
// 音源1つ分の状態をまとめて持つ
function createTrack(outputIndex, canvasId) {
    const gain = audioContext.createGain();
    gain.channelCount = 1;
    gain.channelCountMode = "explicit";
    gain.channelInterpretation = "speakers";
    gain.connect(merger, 0, outputIndex);
    return {
        name: outputIndex === 0 ? "左" : "右",
        buffer: null,
        peaks: null,
        pitch: null,          // 音程の解析結果
        gain: gain,
        canvas: document.getElementById(canvasId),
        offset: 0,            // 停止中の再生位置（秒）
        volume: 1,
        muted: false,
        pinStart: null,       // ループ開始ピン（なし=null）
        pinEnd: null,         // ループ終了ピン（なし=null）
        range: null           // ループ再生中の区間 {s, e}
    };
}
 
const left = createTrack(0, "leftWave");
const right = createTrack(1, "rightWave");
const tracks = [left, right];
 
 
// ===== HTMLから部品を取得 =====
const $ = id => document.getElementById(id);
const leftFile = $("leftFile"), rightFile = $("rightFile");
const playButton = $("playButton"), stopButton = $("stopButton"), syncButton = $("syncButton");
const backButton = $("backButton"), forwardButton = $("forwardButton");
const timeDisplay = $("timeDisplay");
const linkButton = $("linkButton");
const leftWaveLockButton = $("leftWaveLockButton");
const rightWaveLockButton = $("rightWaveLockButton");
const leftMuteButton = $("leftMuteButton"), rightMuteButton = $("rightMuteButton");
const loopSettingsButton = $("loopSettingsButton"), loopControls = $("loopControls");
const loopPlayButton = $("loopPlayButton"), pinInfo = $("pinInfo");
const settingsButton = $("settingsButton");
const skipTime = $("skipTime"), volumeStep = $("volumeStep"), playbackRate = $("playbackRate"), waveWindow = $("waveWindow");
const leftVolume = $("leftVolume"), rightVolume = $("rightVolume");
const fileToggleButton = $("fileToggleButton"), detailToggleButton = $("detailToggleButton"), viewToggleButton = $("viewToggleButton");
const fileSection = $("fileSection"), detailPanel = $("detailPanel");
const graphArea = $("graphArea"), pitchCanvas = $("pitchCanvas"), pitchStatus = $("pitchStatus");
const volumeInfo = $("volumeInfo");
 
 
// ===== 状態 =====
let isPlaying = false;
let loopMode = false;      // 周回ループ中か
let loopOpen = false;      // ループ設定を開いているか
let pitchMode = false;     // 音程表示中か（false=波形）
let selected = null;       // タップした音程バー {idx: 0=左/1=右, bar}
let linked = true;         // 連動ON（片方を動かすともう片方も同じ分だけ動く）
let leftWaveLocked = localStorage.getItem("leftWaveLocked") === "true";
let rightWaveLocked = localStorage.getItem("rightWaveLocked") === "true";
let waveWindowSeconds = Number(localStorage.getItem("waveWindowSeconds") ?? 5);
if (!Number.isFinite(waveWindowSeconds)) waveWindowSeconds = 5;
waveWindowSeconds = Math.min(120, Math.max(0.5, waveWindowSeconds));
const PLAYHEAD_RATIO = 0.5;
let sources = [];          // 今鳴らしている音のノード
let startedAt = 0;         // 通常再生を始めた時刻
let activeRate = 1;        // 再生開始時の速度
let cycleStart = 0;        // ループの今の周の開始時刻
let nextCycleAt = 0;       // ループの次の周の開始時刻
let cycleLen = 0;          // ループ1周の長さ（秒、長い方に合わせる）
let cycleScheduled = false;
 
 
// ===== 基本の関数 =====
const dur = t => t.buffer ? t.buffer.duration : 0;
const totalDuration = () => Math.max(dur(left), dur(right));
const clampTime = (t, sec) => Math.min(Math.max(0, sec), dur(t));
// ロックは波形表示のときだけ効く（音程表示のときは、ロックしていても操作できる）
const isLocked = t => !pitchMode && (t === left ? leftWaveLocked : rightWaveLocked);
 
function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
}
 
// その音源の今の再生位置（秒）
function getPos(t) {
    if (!isPlaying || !t.buffer || isLocked(t)) return t.offset;
    const now = audioContext.currentTime;
    if (loopMode) {
        const r = t.range;
        return r.s + Math.min(Math.max(0, now - cycleStart) * activeRate, r.e - r.s);
    }
    return Math.min(dur(t), t.offset + Math.max(0, now - startedAt) * activeRate);
}
 
// 再生中の位置を offset に保存する（鳴らし直す前に呼ぶ）
function capture() {
    if (isPlaying) for (const t of tracks) t.offset = getPos(t);
}
 
function stopSources() {
    for (const s of sources) {
        s.onended = null;
        try { s.stop(); } catch (e) { /* 停止済みなら無視 */ }
        s.disconnect();
    }
    sources = [];
}
 
function playBuffer(t, when, from, length) {
    const src = audioContext.createBufferSource();
    src.buffer = t.buffer;
    src.playbackRate.value = activeRate;
    src.connect(t.gain);
    if (length === undefined) src.start(when, from);
    else src.start(when, from, length);
    src.onended = function() { sources = sources.filter(s => s !== src); };
    sources.push(src);
}
 
// 通常再生：左右それぞれの offset から、同じ時刻に鳴らし始める
function startNormal() {
    stopSources();
    activeRate = Number(playbackRate.value);
    const when = audioContext.currentTime + 0.05;
    for (const t of tracks) {
        if (t.buffer && !isLocked(t) && t.offset < dur(t)) playBuffer(t, when, t.offset);
    }
    startedAt = when;
    isPlaying = true;
    loopMode = false;
}
 
// ループ再生：各音源の [開始, 終了] を、左右同時に始めて繰り返す
function startLoop() {
    stopSources();
    activeRate = Number(playbackRate.value);
    let maxLen = 0;
    for (const t of tracks) {
        if (!t.buffer) continue;
        t.range = { s: t.pinStart ?? 0, e: t.pinEnd ?? dur(t) };
        maxLen = Math.max(maxLen, t.range.e - t.range.s);
    }
    cycleLen = maxLen / activeRate;   // 長い方が終わるまで待つ
    const when = audioContext.currentTime + 0.05;
    scheduleCycle(when);
    cycleStart = when;
    nextCycleAt = when + cycleLen;
    cycleScheduled = false;
    isPlaying = true;
    loopMode = true;
}
 
function scheduleCycle(when) {
    for (const t of tracks) {
        if (t.buffer) playBuffer(t, when, t.range.s, t.range.e - t.range.s);
    }
}
 
// 次の周を、少し前もって予約する
function tickLoop() {
    if (!loopMode || !isPlaying) return;
    const now = audioContext.currentTime;
    if (now >= nextCycleAt) {
        cycleStart = nextCycleAt;
        nextCycleAt += cycleLen;
        cycleScheduled = false;
    }
    if (!cycleScheduled && now >= nextCycleAt - 0.3) {
        scheduleCycle(nextCycleAt);
        cycleScheduled = true;
    }
}
 
function pauseAll() {
    capture();
    stopSources();
    isPlaying = false;
    loopMode = false;
    updateButtons();
}
 
function stopAll() {
    stopSources();
    isPlaying = false;
    loopMode = false;
    for (const t of tracks) if (!isLocked(t)) t.offset = 0;
    updateButtons();
}
 
function updateButtons() {
    playButton.textContent = (isPlaying && !loopMode) ? "⏸ 一時停止" : "▶ 再生";
    loopPlayButton.textContent = (isPlaying && loopMode) ? "■ 再生停止！" : "▶ 再生開始！";
    linkButton.textContent = linked ? "連動：ON" : "連動：OFF";
    // 左右とも波形をロックしている間は、再生・停止・スキップなどを押せなくする
    const allLocked = isLocked(left) && isLocked(right);
    for (const b of [playButton, stopButton, backButton, forwardButton, syncButton, loopPlayButton]) b.disabled = allLocked;
    viewToggleButton.textContent = pitchMode ? "📊 波形へ" : "🎵 音程へ";
    leftWaveLockButton.textContent = leftWaveLocked ? "🔒 左波形：ロック中" : "🔓 左波形：操作OK";
    rightWaveLockButton.textContent = rightWaveLocked ? "🔒 右波形：ロック中" : "🔓 右波形：操作OK";
    for (const t of tracks) {
        const b = t === left ? leftMuteButton : rightMuteButton;
        b.textContent = t.muted ? `🔇 ${t.name}：ミュート中` : `🔊 ${t.name}：音あり`;
    }
}
 
 
// ===== 再生ボタン・ループ再生ボタン =====
// useLoop: false=通常再生、true=ループ設定の再生ボタン
async function togglePlay(useLoop) {
    if (isPlaying && useLoop === loopMode) {
        pauseAll();
        return;
    }
    if (totalDuration() === 0) {
        alert("先に音源を選択してください");
        return;
    }
 
    const hasEnd = tracks.some(t => t.pinEnd !== null);
    if (useLoop && hasEnd) {
        for (const t of tracks) {
            if (t.buffer && (t.pinEnd ?? dur(t)) - (t.pinStart ?? 0) < 0.5) {
                alert(`${t.name}のループは、終了を開始より0.5秒以上後にしてください`);
                return;
            }
        }
    }
 
    await audioContext.resume();   // iPhoneではタップ操作の中で必要
    if (isPlaying) pauseAll();     // 別のモードから切り替えるとき
 
    if (useLoop && !hasEnd) {
        // 終了ピンがなければ、開始ピンの位置からそのまま再生
        for (const t of tracks) if (t.pinStart !== null) t.offset = t.pinStart;
        useLoop = false;
    }
    if (useLoop) startLoop();
    else startNormal();
    updateButtons();
}
 
playButton.addEventListener("click", () => togglePlay(false));
loopPlayButton.addEventListener("click", () => togglePlay(true));
stopButton.addEventListener("click", stopAll);
 
 
// ===== 戻る・進む・強制同期 =====
function skip(sign) {
    if (loopMode) return;
    const wasPlaying = isPlaying;
    capture();
    const d = sign * Number(skipTime.value);
    for (const t of tracks) if (!isLocked(t)) t.offset = clampTime(t, t.offset + d);
    if (wasPlaying) startNormal();
}
 
backButton.addEventListener("click", () => skip(-1));
forwardButton.addEventListener("click", () => skip(1));
 
// 強制同期：右の位置を左の位置に合わせる
syncButton.addEventListener("click", function() {
    if (loopMode || !left.buffer || !right.buffer) return;
    const wasPlaying = isPlaying;
    capture();
    if (!isLocked(right)) right.offset = clampTime(right, left.offset);
    if (wasPlaying) startNormal();
});
 
function updateSkipButtonText() {
    backButton.textContent = `↩ ${skipTime.value}秒戻る`;
    forwardButton.textContent = `↪ ${skipTime.value}秒進む`;
}
 
 
// ===== 連動・ミュート =====
linkButton.addEventListener("click", function() {
    linked = !linked;
    updateButtons();
});

leftWaveLockButton.addEventListener("click", function() {
    capture();   // 動いている位置を保存してから切り替える
    leftWaveLocked = !leftWaveLocked;
    localStorage.setItem("leftWaveLocked", leftWaveLocked);
    restartForLock();   // ロックの変化に合わせて鳴らし直す
    updateButtons();
});

rightWaveLockButton.addEventListener("click", function() {
    capture();   // 動いている位置を保存してから切り替える
    rightWaveLocked = !rightWaveLocked;
    localStorage.setItem("rightWaveLocked", rightWaveLocked);
    restartForLock();   // ロックの変化に合わせて鳴らし直す
    updateButtons();
});
 
function applyGain(t) {
    t.gain.gain.value = t.muted ? 0 : t.volume;
}
 
leftMuteButton.addEventListener("click", function() {
    left.muted = !left.muted;
    applyGain(left);
    updateButtons();
});
 
rightMuteButton.addEventListener("click", function() {
    right.muted = !right.muted;
    applyGain(right);
    updateButtons();
});
 
 
// ===== 再生速度（変えると音程も変わる） =====
playbackRate.addEventListener("change", function() {
    if (isPlaying) {
        if (loopMode) {
            startLoop();
        } else {
            capture();
            startNormal();
        }
    }
    localStorage.setItem("playbackRate", playbackRate.value);
});
 
 
// ===== 波形 =====
const PEAK_BINS = 2000;
 
// 音源を2000区間に分けて、区間ごとの最大音量を求める
function computePeaks(buffer) {
    const peaks = new Float32Array(PEAK_BINS);
    const length = buffer.length;
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        const data = buffer.getChannelData(ch);
        for (let i = 0; i < PEAK_BINS; i++) {
            const from = Math.floor(i * length / PEAK_BINS);
            const to = Math.floor((i + 1) * length / PEAK_BINS);
            let max = peaks[i];
            for (let j = from; j < to; j += 8) {
                const v = Math.abs(data[j]);
                if (v > max) max = v;
            }
            peaks[i] = max;
        }
    }
    let top = 0;
    for (const p of peaks) if (p > top) top = p;
    if (top > 0) for (let i = 0; i < PEAK_BINS; i++) peaks[i] /= top;
    return peaks;
}
 
function timeToX(sec, viewStart, viewEnd, w) {
    return (sec - viewStart) / (viewEnd - viewStart) * w;
}

function getWaveView(t, total) {
    const duration = dur(t);
    if (!duration || !total) return { start: 0, end: duration || 0 };

    // 赤い再生ラインを常に画面中央に固定し、波形を左右へ流す。
    // 音源の前後は空白として表示することで、開始/終了付近でも中央固定を維持。
    const windowSize = waveWindowSeconds;
    const pos = Math.min(duration, Math.max(0, getPos(t)));
    const half = windowSize * PLAYHEAD_RATIO;
    return { start: pos - half, end: pos + (windowSize - half) };
}

function drawPin(c, sec, viewStart, viewEnd, w, h, color) {
    if (sec === null || sec < viewStart || sec > viewEnd) return;
    const x = timeToX(sec, viewStart, viewEnd, w);
    c.fillStyle = color;
    c.fillRect(x - 1, 0, 2, h);
    c.beginPath();
    c.moveTo(x - 8, 0);
    c.lineTo(x + 8, 0);
    c.lineTo(x, 12);
    c.fill();
}

function drawWave(t, total) {
    const canvas = t.canvas;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;

    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
    }
    const c = canvas.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);

    if (!t.peaks || total === 0) {
        c.fillStyle = "#999";
        c.font = "14px sans-serif";
        c.textAlign = "center";
        c.fillText(`${t.name}音源を選択してください`, w / 2, h / 2 + 5);
        return;
    }

    const duration = dur(t);
    const view = getWaveView(t, total);
    const viewSpan = Math.max(0.001, view.end - view.start);
    const mid = h / 2;

    c.fillStyle = "#4a90d9";
    for (let x = 0; x < w; x++) {
        const t0 = view.start + x / w * viewSpan;
        const t1 = view.start + (x + 1) / w * viewSpan;
        if (t1 <= 0 || t0 >= duration) continue;

        const visibleT0 = Math.max(0, t0);
        const visibleT1 = Math.min(duration, t1);
        const i0 = Math.max(0, Math.floor(visibleT0 / duration * PEAK_BINS));
        const i1 = Math.min(PEAK_BINS, Math.max(i0 + 1, Math.ceil(visibleT1 / duration * PEAK_BINS)));

        let p = 0;
        for (let i = i0; i < i1; i++) {
            if (t.peaks[i] > p) p = t.peaks[i];
        }
        const amp = Math.max(1, p * mid * 0.95);
        c.fillRect(x, mid - amp, 1, amp * 2);
    }

    // ループ設定を開いているときだけ、ピンと範囲を表示
    if (loopOpen) {
        if (t.pinStart !== null || t.pinEnd !== null) {
            const rs = Math.max(view.start, t.pinStart ?? 0);
            const re = Math.min(view.end, t.pinEnd ?? duration);
            if (re > rs) {
                const sx = timeToX(rs, view.start, view.end, w);
                const ex = timeToX(re, view.start, view.end, w);
                c.fillStyle = "rgba(46,125,50,0.12)";
                c.fillRect(sx, 0, ex - sx, h);
            }
        }
        drawPin(c, t.pinStart, view.start, view.end, w, h, "#2e7d32");
        drawPin(c, t.pinEnd, view.start, view.end, w, h, "#ef6c00");
    }

    // 赤い再生位置は常に枠の中央に固定
    const playheadX = w * PLAYHEAD_RATIO;
    c.fillStyle = "#e53935";
    c.fillRect(playheadX - 1, 0, 2, h);
}

// 波形のタップ・ドラッグ
function setupWave(t) {
    const canvas = t.canvas;
    let drag = null;
    const getLocked = () => isLocked(t);

    const toTime = e => {
        const r = canvas.getBoundingClientRect();
        const view = getWaveView(t, totalDuration());
        const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
        return clampTime(t, view.start + ratio * (view.end - view.start));
    };

    // ドラッグ開始位置を基準に波形を動かす。赤線は中央に固定。
    const moveByPixels = (startX, currentX, startTime, viewSpan, width) => {
        const delta = (currentX - startX) / width * viewSpan;
        const time = clampTime(t, startTime - delta);
        const actualDelta = time - t.offset;
        t.offset = time;
        if (linked) {
            for (const o of tracks) {
                if (o !== t && o.buffer && !isLocked(o)) o.offset = clampTime(o, o.offset + actualDelta);
            }
        }
    };

    canvas.addEventListener("pointerdown", function(e) {
        if (!t.buffer || getLocked()) return;
        const r = canvas.getBoundingClientRect();
        const x = e.clientX - r.left;
        const total = totalDuration();
        const view = getWaveView(t, total);

        let key = null;
        let best = 16;
        if (loopOpen) {
            for (const k of ["pinStart", "pinEnd"]) {
                if (t[k] === null || t[k] < view.start || t[k] > view.end) continue;
                const d = Math.abs(timeToX(t[k], view.start, view.end, r.width) - x);
                if (d < best) { best = d; key = k; }
            }
        }

        if (key) {
            drag = { key: key };
        } else {
            if (loopMode) return;
            drag = {
                key: null,
                wasPlaying: isPlaying,
                startX: x,
                startTime: getPos(t),
                viewSpan: view.end - view.start,
                width: r.width
            };
            if (isPlaying) pauseAll();
        }
        canvas.setPointerCapture(e.pointerId);
    });

    canvas.addEventListener("pointermove", function(e) {
        if (!drag || getLocked()) return;
        if (drag.key) {
            t[drag.key] = toTime(e);
            updatePinInfo();
        } else {
            const r = canvas.getBoundingClientRect();
            const x = e.clientX - r.left;
            moveByPixels(drag.startX, x, drag.startTime, drag.viewSpan, r.width);
        }
    });

    const end = function() {
        if (!drag) return;
        if (!drag.key && drag.wasPlaying && !getLocked()) {
            startNormal();
            updateButtons();
        }
        drag = null;
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
}

tracks.forEach(setupWave);
 
 
// ===== ループ設定（開いているときだけ有効） =====
loopSettingsButton.addEventListener("click", function() {
    loopOpen = !loopOpen;
 
    // 開くときも閉じるときも、ピンは白紙に戻す
    for (const t of tracks) { t.pinStart = null; t.pinEnd = null; }
 
    // ループ再生中に閉じたら、通常再生に切り替えて続ける
    if (!loopOpen && loopMode) {
        capture();
        startNormal();
        updateButtons();
    }
 
    loopControls.classList.toggle("open", loopOpen);
    updatePinInfo();
});
 
// ピンボタン：その音源の今の再生位置をピンにする
function setPin(t, key) {
    if (!t.buffer) return;
    t[key] = getPos(t);
    updatePinInfo();
}
 
$("leftPinStart").addEventListener("click", () => setPin(left, "pinStart"));
$("leftPinEnd").addEventListener("click", () => setPin(left, "pinEnd"));
$("rightPinStart").addEventListener("click", () => setPin(right, "pinStart"));
$("rightPinEnd").addEventListener("click", () => setPin(right, "pinEnd"));
 
function updatePinInfo() {
    if (!loopOpen) return;
    const f = v => v === null ? "なし" : formatTime(v);
    let text = `左　開始 ${f(left.pinStart)}　終了 ${f(left.pinEnd)}\n` +
               `右　開始 ${f(right.pinStart)}　終了 ${f(right.pinEnd)}`;
 
    if (left.buffer && right.buffer && tracks.some(t => t.pinEnd !== null)) {
        const len = t => (t.pinEnd ?? dur(t)) - (t.pinStart ?? 0);
        text += `\nループの長さの差 ${Math.abs(len(left) - len(right)).toFixed(1)}秒`;
    }
    pinInfo.textContent = text;
}
 
 
// ===== 音程（ピッチ）の解析と表示 =====
const PITCH_LOW = 80, PITCH_HIGH = 1000;   // 検出する声の高さの範囲（Hz）
const PITCH_HOP = 0.02;                    // 解析の間隔（秒）
const NOTE_NAMES = { 0: "ド", 2: "レ", 4: "ミ", 5: "ファ", 7: "ソ", 9: "ラ", 11: "シ" };
let pitchMin = 48, pitchMax = 72;          // 縦軸の範囲（MIDIノート番号）

const freqToMidi = f => 69 + 12 * Math.log2(f / 440);

// YIN法：1フレーム分の「声の高さの候補」を最大3つ返す（1つに決めるのは後でまとめてやる）
function yinCandidates(x, start, W, tauMin, tauMax, rate) {
    const d = new Float32Array(tauMax + 1);
    for (let tau = 1; tau <= tauMax; tau++) {
        let sum = 0;
        for (let i = 0; i < W; i++) {
            const diff = x[start + i] - x[start + i + tau];
            sum += diff * diff;
        }
        d[tau] = sum;
    }
    // 累積平均で正規化
    let running = 0;
    d[0] = 1;
    for (let tau = 1; tau <= tauMax; tau++) {
        running += d[tau];
        d[tau] = running === 0 ? 1 : d[tau] * tau / running;
    }
    // 谷になっているところ（周期の候補）を集める
    const found = [];
    for (let tau = Math.max(2, tauMin); tau < tauMax; tau++) {
        if (d[tau] < 0.4 && d[tau] < d[tau - 1] && d[tau] <= d[tau + 1]) {
            const a = d[tau - 1], b = d[tau], c = d[tau + 1];
            const denom = a - 2 * b + c;
            const shift = denom !== 0 ? (a - c) / (2 * denom) : 0;   // 放物線で細かく補間
            // 低い方に少しだけ不利にして、1オクターブ下の見間違いを減らす
            found.push({ midi: freqToMidi(rate / (tau + shift)), cost: d[tau] + 0.05 * tau / tauMax });
        }
    }
    found.sort((p, q) => p.cost - q.cost);
    return found.slice(0, 3);
}

// ===== 歌い方（技法）の検出：しゃくり・ビブラート・フォール =====
const meanOf = arr => {
    const v = Array.from(arr).filter(x => !Number.isNaN(x));
    return v.length ? v.reduce((p, q) => p + q, 0) / v.length : NaN;
};
const medianOf = arr => {
    const v = Array.from(arr).filter(x => !Number.isNaN(x)).sort((p, q) => p - q);
    return v.length ? v[v.length >> 1] : NaN;
};

// バー1本ぶんの音程の動き（midi）から、歌い方を調べる。あくまで目安
function detectTechniques(midi, b, hopSec) {
    const tech = [];
    const target = medianOf(midi.slice(b.a, b.b));
    if (Number.isNaN(target)) return tech;

    // しゃくり：声が出た直後（前の音の続きではない）に、目的の音より下から上がってくる
    let s = b.a;
    while (s > 0 && !Number.isNaN(midi[s - 1]) && b.a - s < 8) s--;
    if (s === 0 || Number.isNaN(midi[s - 1])) {
        const start = meanOf(midi.slice(s, s + 3));
        const later = meanOf(midi.slice(s + 4, s + 8));
        const rise = target - start;
        if (rise >= 0.8 && rise <= 4 && later > start + 0.4) tech.push("しゃくり");
    }

    // ビブラート：0.3秒以上のバーで、1秒間に3.5〜8.5回ほど細かく上下に揺れている
    const n = b.b - b.a;
    if (n >= 15) {
        const v = [];
        let last = target, miss = 0;
        for (let f = b.a; f < b.b; f++) {
            if (Number.isNaN(midi[f])) miss++; else last = midi[f];
            v.push(last);
        }
        if (miss <= n * 0.2) {
            // ゆっくりした動きを引いて、細かい揺れだけにする
            const d = v.map(function(x, i) {
                let sum = 0, c = 0;
                for (let j = Math.max(0, i - 12); j <= Math.min(n - 1, i + 12); j++) { sum += v[j]; c++; }
                return x - sum / c;
            });
            const std = Math.sqrt(d.reduce((p, q) => p + q * q, 0) / n);
            if (std >= 0.2) {
                let flips = 0, state = 0;
                for (const x of d) {
                    if (x > std * 0.3 && state <= 0) { if (state === -1) flips++; state = 1; }
                    else if (x < -std * 0.3 && state >= 0) { if (state === 1) flips++; state = -1; }
                }
                const hz = flips / 2 / (n * hopSec);
                if (hz >= 3.5 && hz <= 8.5) tech.push("ビブラート");
            }
        }
    }

    // フォール：語尾で音が下がって消える
    let e = b.b;
    while (e < midi.length && !Number.isNaN(midi[e]) && e - b.b < 8) e++;
    if (e >= midi.length || Number.isNaN(midi[e])) {
        const drop = target - meanOf(midi.slice(e - 3, e));
        if (drop >= 1 && drop <= 6) tech.push("フォール");
    }
    return tech;
}

// 音源全体の音程を解析して t.pitch に入れる
async function analyzePitch(t) {
    const buf = t.buffer;
    // 全チャンネルを平均して、約22kHzに間引く（計算を軽くするため）
    const step = Math.max(1, Math.round(buf.sampleRate / 22050));
    const rate = buf.sampleRate / step;
    const n = Math.floor(buf.length / step);
    const x = new Float32Array(n);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
        const data = buf.getChannelData(ch);
        for (let i = 0; i < n; i++) {
            let sum = 0;
            for (let k = 0; k < step; k++) sum += data[i * step + k];
            x[i] += sum / step / buf.numberOfChannels;
        }
    }

    const W = Math.round(rate * 0.035);
    const tauMin = Math.floor(rate / PITCH_HIGH);
    const tauMax = Math.ceil(rate / PITCH_LOW);
    const hop = Math.round(rate * PITCH_HOP);
    const frames = Math.max(0, Math.floor((n - W - tauMax - 1) / hop));
    const level = new Float32Array(frames);   // 音量(dB)。音量表示用に取っておく
    const cands = new Array(frames);

    // ① 各フレームの音程の候補を出す（ここが一番時間がかかる）
    for (let f = 0; f < frames; f++) {
        const start = f * hop;
        let e = 0;
        for (let i = 0; i < W; i++) e += x[start + i] * x[start + i];
        level[f] = 10 * Math.log10(e / W + 1e-12);
        cands[f] = level[f] > -60 ? yinCandidates(x, start, W, tauMin, tauMax, rate) : [];
        if (f % 100 === 0) {
            pitchStatus.textContent = `${t.name}音源の音程を解析中… ${Math.round(f / frames * 100)}%`;
            await new Promise(r => setTimeout(r, 0));   // 画面が固まらないよう一息入れる
        }
    }

    // ② 前後のつながりを見て、一番自然な音程の流れを選ぶ（ビタビ法）
    //    コーラスなどで候補が複数あっても、急に飛ばない流れを優先する
    const cost = new Array(frames), back = new Array(frames);
    for (let f = 0; f < frames; f++) {
        const c = cands[f], m = c.length + 1;     // 最後の1つは「声なし」
        cost[f] = new Float32Array(m);
        back[f] = new Int8Array(m);
        for (let s = 0; s < m; s++) {
            const obs = s < c.length ? c[s].cost : 0.25;
            if (f === 0) { cost[f][s] = obs; continue; }
            const pc = cands[f - 1];
            let best = 1e9, bi = 0;
            for (let p = 0; p <= pc.length; p++) {
                let tr;
                if (s < c.length && p < pc.length) tr = 0.06 * Math.min(12, Math.abs(c[s].midi - pc[p].midi));
                else tr = (s === c.length && p === pc.length) ? 0 : 0.15;
                const v = cost[f - 1][p] + tr;
                if (v < best) { best = v; bi = p; }
            }
            cost[f][s] = best + obs;
            back[f][s] = bi;
        }
    }
    const midi = new Float32Array(frames).fill(NaN);
    if (frames > 0) {
        let s = 0;
        for (let k = 1; k < cost[frames - 1].length; k++) if (cost[frames - 1][k] < cost[frames - 1][s]) s = k;
        for (let f = frames - 1; f >= 0; f--) {
            if (s < cands[f].length) midi[f] = cands[f][s].midi;
            s = back[f][s];
        }
    }

    // ③ 前後5フレームの中央値でぶれを取る
    const med = new Float32Array(frames).fill(NaN);
    for (let f = 0; f < frames; f++) {
        const v = [];
        for (let j = Math.max(0, f - 2); j <= Math.min(frames - 1, f + 2); j++) {
            if (!Number.isNaN(midi[j])) v.push(midi[j]);
        }
        if (v.length >= 3) {
            v.sort((p, q) => p - q);
            med[f] = v[v.length >> 1];
        }
    }

    // ④ 半音に丸める。今の音から±0.7半音以内なら同じ音のままにして、少し丸める
    const note = new Float32Array(frames).fill(NaN);
    let cur = NaN, gap = 0;
    for (let f = 0; f < frames; f++) {
        if (Number.isNaN(med[f])) {
            if (++gap > 3) cur = NaN;
            continue;
        }
        gap = 0;
        if (Number.isNaN(cur) || Math.abs(med[f] - cur) > 0.7) cur = Math.round(med[f]);
        note[f] = cur;
    }

    // ⑤ 前後が同じ音なら、短い途切れ（約0.1秒まで）をつないでとびとびを防ぐ
    for (let f = 1; f < frames; f++) {
        if (Number.isNaN(note[f]) && !Number.isNaN(note[f - 1])) {
            let g = f;
            while (g < frames && Number.isNaN(note[g])) g++;
            if (g < frames && g - f <= 5 && note[g] === note[f - 1]) {
                for (let k = f; k < g; k++) note[k] = note[f - 1];
            }
            f = g;
        }
    }

    // ⑥ 同じ音が続くところを1本のバーにまとめる（3フレーム未満は捨てる）
    const bars = [];
    let a = 0;
    for (let f = 1; f <= frames; f++) {
        if (f === frames || note[f] !== note[a] || Number.isNaN(note[a])) {
            if (!Number.isNaN(note[a]) && f - a >= 3) bars.push({ a: a, b: f, n: note[a] });
            a = f;
        }
    }

    // ⑦ 歌い方（しゃくり・ビブラート・フォール）をバーごとに調べる
    for (const b of bars) b.tech = detectTechniques(midi, b, hop / rate);

    // ⑧ バーごとの音量（平均dB）と、音源全体の平均・中央値・最高・最低を出す
    let stats = null;
    if (bars.length > 0) {
        for (const b of bars) {
            let sum = 0;
            for (let f = b.a; f < b.b; f++) sum += level[f];
            b.vol = sum / (b.b - b.a);
        }
        const v = bars.map(b => b.vol).sort((p, q) => p - q);
        const mid = v.length >> 1;
        stats = {
            mean: v.reduce((p, q) => p + q, 0) / v.length,
            median: v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2,
            max: v[v.length - 1],
            min: v[0]
        };
        bars.find(b => b.vol === stats.max).mark = "max";   // 最高・最低のバーに目印を付ける
        bars.find(b => b.vol === stats.min).mark = "min";
    }

    t.pitch = { midi: midi, level: level, bars: bars, stats: stats, hopSec: hop / rate, t0: (W / 2) / rate };
}

// 縦軸の範囲を、左右の音源のバーから決める（外れ値は除く）
function updatePitchRange() {
    const all = [];
    for (const t of tracks) if (t.pitch) for (const b of t.pitch.bars) all.push(b.n);
    if (all.length === 0) return;
    all.sort((p, q) => p - q);
    const lo = all[Math.floor(all.length * 0.02)];
    const hi = all[Math.floor(all.length * 0.98)];
    pitchMin = Math.floor(lo) - 2;
    pitchMax = Math.ceil(hi) + 2;
    if (pitchMax - pitchMin < 12) pitchMax = pitchMin + 12;
}

// 音程グラフを描く（左=青、右=オレンジ。音量OFFの側は描かない）
function drawPitch(total) {
    const canvas = pitchCanvas;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;

    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
    }
    const c = canvas.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);

    // 縦軸は上が高い音。ド・レ・ミの線を薄く引く
    const top = pitchMax + 0.5, bottom = pitchMin - 0.5;
    const yOf = m => (top - m) / (top - bottom) * h;
    const rowH = h / (top - bottom);
    c.font = "9px sans-serif";
    c.textAlign = "left";
    for (let m = pitchMin; m <= pitchMax; m++) {
        const name = NOTE_NAMES[((m % 12) + 12) % 12];
        if (!name) continue;
        const y = yOf(m);
        c.fillStyle = m % 12 === 0 ? "#ccc" : "#eee";
        c.fillRect(0, y - 0.5, w, 1);
        if (rowH >= 4.5 || m % 12 === 0) {
            c.fillStyle = "#aaa";
            c.fillText(name, 2, y - 2);
        }
    }

    if (!tracks.some(t => t.pitch)) {
        c.fillStyle = "#999";
        c.font = "14px sans-serif";
        c.textAlign = "center";
        c.fillText("音源を選ぶと音程を解析します", w / 2, h / 2 + 5);
    }

    const vis = [null, null];   // 左右の見えているバーの位置（重なり判定用）
    const colors = [["#4a90d9", "rgba(74,144,217,0.35)"], ["#ef8a2d", "rgba(239,138,45,0.35)"]];
    tracks.forEach(function(t, idx) {
        if (!t.pitch || t.muted) return;
        vis[idx] = [];
        const p = t.pitch;
        const view = getWaveView(t, total);

        // 実際の音程の細かい動きを、薄い線で重ねる
        const f0 = Math.max(0, Math.floor((view.start - p.t0) / p.hopSec) - 1);
        const f1 = Math.min(p.midi.length - 1, Math.ceil((view.end - p.t0) / p.hopSec) + 1);
        c.strokeStyle = colors[idx][1];
        c.lineWidth = 1;
        c.beginPath();
        let pen = false;
        for (let f = f0; f <= f1; f++) {
            if (Number.isNaN(p.midi[f])) { pen = false; continue; }
            const x = timeToX(f * p.hopSec + p.t0, view.start, view.end, w);
            const y = yOf(p.midi[f]);
            if (pen) c.lineTo(x, y); else c.moveTo(x, y);
            pen = true;
        }
        c.stroke();

        // 半音に丸めたバー（同じ音が続けば、ーーーのように長くなる）
        c.fillStyle = colors[idx][0];
        for (const b of p.bars) {
            if (b.b < f0 || b.a > f1) continue;
            const x0 = timeToX(b.a * p.hopSec + p.t0, view.start, view.end, w);
            const x1 = timeToX(b.b * p.hopSec + p.t0, view.start, view.end, w);
            c.fillRect(x0, yOf(b.n) - 3, Math.max(2, x1 - x0 - 1), 6);
            vis[idx].push({ x0: x0, x1: x1, n: b.n, mark: b.mark, tech: b.tech, bar: b });
        }
    });

    // 左右が同じ音で重なったところは緑にする
    if (vis[0] && vis[1]) {
        c.fillStyle = "#2e9e5b";
        let j = 0;
        for (const p of vis[0]) {
            while (j < vis[1].length && vis[1][j].x1 <= p.x0) j++;
            for (let k = j; k < vis[1].length && vis[1][k].x0 < p.x1; k++) {
                const q = vis[1][k];
                if (q.n !== p.n) continue;
                const x0 = Math.max(p.x0, q.x0), x1 = Math.min(p.x1, q.x1);
                if (x1 > x0) c.fillRect(x0, yOf(p.n) - 3, Math.max(2, x1 - x0 - 1), 6);
            }
        }
    }

    // 最高・最低の音量のバーは色を変えて目印にする。タップしたバーは黒枠
    for (let idx = 0; idx < 2; idx++) {
        if (!vis[idx]) continue;
        for (const q of vis[idx]) {
            const y = yOf(q.n) - 3, wd = Math.max(2, q.x1 - q.x0 - 1);
            if (q.mark) {
                c.fillStyle = q.mark === "max" ? "#c2185b" : "#263238";
                c.fillRect(q.x0, y, wd, 6);
            }
            if (q.tech && q.tech.length && q.x1 - q.x0 >= 8) {
                c.font = "bold 11px sans-serif";
                c.textAlign = "center";
                c.fillStyle = colors[idx][0];
                if (q.tech.includes("しゃくり")) c.fillText("↗", q.x0 + 4, y - 2);
                if (q.tech.includes("ビブラート")) c.fillText("〜", (q.x0 + q.x1) / 2, y - 2);
                if (q.tech.includes("フォール")) c.fillText("↘", q.x1 - 4, y - 2);
            }
            if (selected && selected.idx === idx && selected.bar === q.bar) {
                c.strokeStyle = "#000";
                c.lineWidth = 2;
                c.strokeRect(q.x0 - 1, y - 2, wd + 2, 10);
            }
        }
    }

    // 赤い再生位置は波形と同じく中央に固定
    c.fillStyle = "#e53935";
    c.fillRect(w * PLAYHEAD_RATIO - 1, 0, 2, h);
}


// ===== 画面の更新 =====
function updateUI() {
    // 最後まで再生したら先頭に戻して停止
    if (isPlaying && !loopMode && tracks.every(t => !t.buffer || isLocked(t) || getPos(t) >= dur(t) - 0.01)) {
        stopAll();
    }
 
    timeDisplay.textContent =
        `左 ${formatTime(getPos(left))} / ${formatTime(dur(left))}　` +
        `右 ${formatTime(getPos(right))} / ${formatTime(dur(right))}`;
 
    const total = totalDuration();
    drawWave(left, total);
    drawWave(right, total);
    // 再生中・波形表示中は、タップの選択を外す
    if (isPlaying || !pitchMode) selected = null;
    drawPitch(total);
    updateVolumeInfo();
    updatePinInfo();
}
 
setInterval(function() {
    tickLoop();
    updateUI();
}, 50);
 
 
// ===== ファイルの読み込み =====
function decodeAudio(arrayBuffer) {
    return new Promise(function(resolve, reject) {
        const p = audioContext.decodeAudioData(arrayBuffer, resolve, reject);
        if (p && p.catch) p.catch(reject);
    });
}
 
async function loadFile(input, t) {
    const file = input.files[0];
    if (!file) return;
 
    stopAll();
    t.pinStart = null;
    t.pinEnd = null;
    t.pitch = null;
    selected = null;
    console.log(`${t.name}音源:`, file.name, file.type, file.size);
    timeDisplay.textContent = `${t.name}音源を読み込み中…`;
 
    try {
        const arrayBuffer = await file.arrayBuffer();
        t.buffer = await decodeAudio(arrayBuffer);
        t.peaks = computePeaks(t.buffer);
        console.log(`${t.name}音源の長さ:`, t.buffer.duration);
    } catch (e) {
        t.buffer = null;
        t.peaks = null;
        console.error(`${t.name}音源の読み込みエラー:`, e);
        alert(`${t.name}音源を読み込めませんでした。別の形式（m4a / mp3 など）で試してください。`);
    }

    // 読み込めたら、音程も解析しておく（失敗しても再生には影響しない）
    if (t.buffer) {
        try {
            await analyzePitch(t);
            updatePitchRange();
        } catch (e) {
            console.error(`${t.name}音源の音程解析エラー:`, e);
            t.pitch = null;
        }
        pitchStatus.textContent = "";
    }
}
 
leftFile.addEventListener("change", () => loadFile(leftFile, left));
rightFile.addEventListener("change", () => loadFile(rightFile, right));
 
 
// ===== 設定パネルの開閉 =====
settingsButton.addEventListener("click", function() {
    document.body.classList.toggle("settings-open");
});
 
 
// ===== 設定の保存と復元 =====
skipTime.value = localStorage.getItem("skipTime") ?? 5;
volumeStep.value = localStorage.getItem("volumeStep") ?? 0.1;
leftVolume.value = localStorage.getItem("leftVolume") ?? 1;
rightVolume.value = localStorage.getItem("rightVolume") ?? 1;
playbackRate.value = localStorage.getItem("playbackRate") ?? 1;
waveWindow.value = String(waveWindowSeconds);
 
skipTime.addEventListener("change", function() {
    localStorage.setItem("skipTime", skipTime.value);
    updateSkipButtonText();
});
 
volumeStep.addEventListener("change", function() {
    localStorage.setItem("volumeStep", volumeStep.value);
});

waveWindow.addEventListener("change", function() {
    let value = Number(waveWindow.value);
    if (!Number.isFinite(value)) value = 5;
    value = Math.min(120, Math.max(0.5, value));
    value = Math.round(value * 10) / 10;
    waveWindow.value = String(value);
    waveWindowSeconds = value;
    localStorage.setItem("waveWindowSeconds", value);
    updateUI();
});
 
 
// ===== 音量（スライダー・ボタン共通）。GainNodeで操作する =====
function bindVolume(slider, downButton, upButton, t, storageKey) {
    slider.step = "0.01";
 
    function apply(value) {
        value = Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
        slider.value = value;
        t.volume = value;
        applyGain(t);
        localStorage.setItem(storageKey, value);
    }
 
    slider.addEventListener("input", () => apply(Number(slider.value)));
    downButton.addEventListener("click", () => apply(Number(slider.value) - Number(volumeStep.value)));
    upButton.addEventListener("click", () => apply(Number(slider.value) + Number(volumeStep.value)));
    apply(Number(slider.value));
}
 
bindVolume(leftVolume, $("leftVolumeDown"), $("leftVolumeUp"), left, "leftVolume");
bindVolume(rightVolume, $("rightVolumeDown"), $("rightVolumeUp"), right, "rightVolume");
 
 
// ===== 起動時の初期表示 =====
updateSkipButtonText();
updateButtons();
updateUI();

// ===== 出し入れするボタン（ファイル選択・詳細操作・表示切り替え） =====
fileToggleButton.addEventListener("click", () => fileSection.classList.toggle("open"));
detailToggleButton.addEventListener("click", () => detailPanel.classList.toggle("open"));

viewToggleButton.addEventListener("click", function() {
    capture();   // 動いている位置を保存してから切り替える
    pitchMode = !pitchMode;
    graphArea.classList.toggle("pitch-mode", pitchMode);
    volumeInfo.classList.toggle("show", pitchMode);   // 詳細パネルは音程表示のときだけ
    selected = null;
    restartForLock();   // ロックの効き方が変わるので、鳴らし直す
    updateButtons();
});


// ロックを切り替えたとき、再生中なら鳴らし直す（ロックした側だけ止まり、もう片方は続く）
function restartForLock() {
    if (!isPlaying) return;
    if (isLocked(left) && isLocked(right)) pauseAll();
    else if (!loopMode) startNormal();
}


// ===== 音量の統計・タップ詳細パネル =====
const NOTE_JA = ["ド", "ド♯", "レ", "レ♯", "ミ", "ファ", "ファ♯", "ソ", "ソ♯", "ラ", "ラ♯", "シ"];
const noteLabel = m => `${NOTE_JA[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;

function updateVolumeInfo() {
    if (!pitchMode) return;
    const f = v => v.toFixed(1);
    const sign = v => (v >= 0 ? "+" : "") + v.toFixed(1);
    const cmp = v => v >= 0.05 ? "大きい" : v <= -0.05 ? "小さい" : "ほぼ同じ";
    let text = "【声の大きさ】単位はdB（0に近いほど大きい声、マイナスが大きいほど小さい声）\n";
    for (const t of tracks) {
        const st = t.pitch && t.pitch.stats;
        text += `${t.name}：` + (st ? `平均 ${f(st.mean)}dB ／ 中央値 ${f(st.median)}dB ／ 一番大きい ${f(st.max)}dB ／ 一番小さい ${f(st.min)}dB` : "解析待ち") + "\n";
    }
    text += "※平均＝全体のならした大きさ　中央値＝大きい順に並べた真ん中の大きさ\n";
    if (selected) {
        const t = tracks[selected.idx], st = t.pitch.stats, b = selected.bar;
        const dm = b.vol - st.mean, dd = b.vol - st.median;
        text += `\n▶ タップした音（${t.name}）\n` +
                `　高さ：${noteLabel(b.n)}（数字が大きいほど高い音）　長さ：${((b.b - b.a) * t.pitch.hopSec).toFixed(1)}秒\n` +
                `　音量：${f(b.vol)}dB\n` +
                `　平均との差：${sign(dm)}dB（平均より${cmp(dm)}）\n` +
                `　中央値との差：${sign(dd)}dB（中央値より${cmp(dd)}）\n` +
                (b.mark === "max" ? "　★この音源で一番大きい声です\n" : b.mark === "min" ? "　★この音源で一番小さい声です\n" : "") +
                `　歌い方：${b.tech && b.tech.length ? b.tech.join("・") : "特になし"}`;
    } else {
        text += "\n一時停止して音程バーをタップすると、その音の詳細が出ます";
    }
    if (volumeInfo.textContent !== text) volumeInfo.textContent = text;
}

// 一時停止中に音程バーをタップしたら、そのバーを選ぶ
function tapBar(e) {
    if (!pitchMode || isPlaying) return;
    const r = pitchCanvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const total = totalDuration();
    const top = pitchMax + 0.5, bottom = pitchMin - 0.5;
    let best = null, bestD = 14;   // 指で触りやすいよう、少し広めに判定
    tracks.forEach(function(t, idx) {
        if (!t.pitch || t.muted) return;
        const p = t.pitch, view = getWaveView(t, total);
        for (const b of p.bars) {
            const x0 = timeToX(b.a * p.hopSec + p.t0, view.start, view.end, r.width);
            const x1 = timeToX(b.b * p.hopSec + p.t0, view.start, view.end, r.width);
            if (x < x0 - 6 || x > x1 + 6) continue;
            const d = Math.abs((top - b.n) / (top - bottom) * r.height - y);
            if (d < bestD) { bestD = d; best = { idx: idx, bar: b }; }
        }
    });
    selected = best;
    updateVolumeInfo();
}

// ドラッグ（動かした）ではなく、ちょんと触ったときだけタップとして扱う
let tapStart = null;
for (const t of tracks) {
    t.canvas.addEventListener("pointerdown", e => { tapStart = { x: e.clientX, y: e.clientY }; });
    t.canvas.addEventListener("pointerup", function(e) {
        if (tapStart && Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y) < 8) tapBar(e);
        tapStart = null;
    });
}
