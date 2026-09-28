// ============================================================
// カラオケ練習ツール（decodeAudioData方式）
// 音源をメモリに読み込み、AudioBufferSourceNodeで再生する。
// 左右の音源は同じ時計（audioContext.currentTime）で動くのでズレない。
// ============================================================

// ===== Web Audio の準備 =====
const AudioCtx = window.AudioContext || window.webkitAudioContext;
const audioContext = new AudioCtx();

// 左右の出力を分けるための合流ノード（入力0=左耳、入力1=右耳）
const merger = audioContext.createChannelMerger(2);
merger.connect(audioContext.destination);

// 1つの音源（トラック）に必要なものをまとめて作る
// gain: 音量ノード。ステレオ音源でもここでモノラルにまとめて、片耳だけに送る
function createTrack(outputIndex) {
    const gain = audioContext.createGain();
    gain.channelCount = 1;
    gain.channelCountMode = "explicit";
    gain.channelInterpretation = "speakers";
    gain.connect(merger, 0, outputIndex);
    return { buffer: null, gain: gain, source: null };
}

const left = createTrack(0);
const right = createTrack(1);
const tracks = [left, right];


// ===== HTMLから部品を取得 =====
const leftFile = document.getElementById("leftFile");
const rightFile = document.getElementById("rightFile");

const playButton = document.getElementById("playButton");
const stopButton = document.getElementById("stopButton");
const syncButton = document.getElementById("syncButton");
const backButton = document.getElementById("backButton");
const forwardButton = document.getElementById("forwardButton");

const timeDisplay = document.getElementById("timeDisplay");
const seekBar = document.getElementById("seekBar");

const loopStart = document.getElementById("loopStart");
const loopEnd = document.getElementById("loopEnd");
const loopSettingsButton = document.getElementById("loopSettingsButton");
const loopPlayButton = document.getElementById("loopPlayButton");
const loopControls = document.getElementById("loopControls");

const leftVolume = document.getElementById("leftVolume");
const rightVolume = document.getElementById("rightVolume");
const leftVolumeDown = document.getElementById("leftVolumeDown");
const leftVolumeUp = document.getElementById("leftVolumeUp");
const rightVolumeDown = document.getElementById("rightVolumeDown");
const rightVolumeUp = document.getElementById("rightVolumeUp");

const settingsButton = document.getElementById("settingsButton");
const settingsPanel = document.getElementById("settingsPanel");
const skipTime = document.getElementById("skipTime");
const volumeStep = document.getElementById("volumeStep");
const playbackRate = document.getElementById("playbackRate");


// ===== 再生状態 =====
let isPlaying = false;     // 再生中か
let loopMode = false;      // ループ再生中か
let offset = 0;            // 再生位置（秒）。停止・一時停止中はこれが現在位置
let startedAt = 0;         // 再生を始めた時の audioContext.currentTime
let activeRate = 1;        // 再生開始時の速度
let loopRange = { start: 0, end: 0 };  // ループ再生中の範囲（開始時に確定）
let isSeeking = false;     // シークバーを操作中か


// ===== 基本の関数 =====

// 音源の長さ（長い方に合わせる）
function getDuration() {
    return Math.max(left.buffer?.duration ?? 0, right.buffer?.duration ?? 0);
}

// 現在の再生位置（秒）を計算する
function getPosition() {
    if (!isPlaying) return offset;

    const elapsed = Math.max(0, audioContext.currentTime - startedAt);
    let pos = offset + elapsed * activeRate;

    // ループ中は範囲内に折り返す
    if (loopMode && pos >= loopRange.end) {
        const length = loopRange.end - loopRange.start;
        pos = loopRange.start + ((pos - loopRange.start) % length);
    }
    return pos;
}

// 時間の表示用（例：1:05）
function formatTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

// 鳴っている音を全部止める（位置は変えない）
function stopSources() {
    for (const track of tracks) {
        if (track.source) {
            try { track.source.stop(); } catch (e) { /* すでに停止済みなら無視 */ }
            track.source.disconnect();
            track.source = null;
        }
    }
}

// offset の位置から左右を同時に鳴らし始める
function startSources() {
    stopSources();

    const rate = Number(playbackRate.value);
    // 少し先の時刻を指定して、左右が同じタイミングで始まるようにする
    const when = audioContext.currentTime + 0.05;

    // ループ範囲の外なら、ループの頭から
    if (loopMode && offset >= loopRange.end) {
        offset = loopRange.start;
    }

    for (const track of tracks) {
        if (!track.buffer) continue;

        const source = audioContext.createBufferSource();
        source.buffer = track.buffer;
        source.playbackRate.value = rate;

        if (loopMode) {
            // ブラウザ標準のループ機能（サンプル単位で正確）
            source.loop = true;
            source.loopStart = loopRange.start;
            source.loopEnd = loopRange.end;
        }

        source.connect(track.gain);
        source.start(when, Math.min(offset, track.buffer.duration));
        track.source = source;
    }

    startedAt = when;
    activeRate = rate;
    isPlaying = true;
}

// 一時停止（今の位置を覚えておく）
function pauseAll() {
    if (isPlaying) {
        offset = getPosition();
    }
    stopSources();
    isPlaying = false;
    loopMode = false;
    updateButtons();
    updateUI();
}

// 停止（先頭に戻す）
function stopAll() {
    stopSources();
    isPlaying = false;
    loopMode = false;
    offset = 0;
    updateButtons();
    updateUI();
}

// 好きな位置へ移動
function seekTo(seconds) {
    offset = Math.min(Math.max(0, seconds), getDuration());
    if (isPlaying) {
        startSources();
    }
    updateUI();
}

// ボタンの文字を状態に合わせる
function updateButtons() {
    playButton.textContent = (isPlaying && !loopMode) ? "⏸ 一時停止" : "▶ 再生";
    loopPlayButton.textContent = (isPlaying && loopMode) ? "■ 再生停止！" : "▶ 再生開始！";
}

// 画面（時間表示・シークバー）の更新
function updateUI() {
    let pos = getPosition();
    const duration = getDuration();

    // 最後まで再生したら先頭に戻して停止
    if (isPlaying && !loopMode && pos >= duration) {
        stopSources();
        isPlaying = false;
        offset = 0;
        pos = 0;
        updateButtons();
    }

    const leftDur = left.buffer?.duration ?? 0;
    const rightDur = right.buffer?.duration ?? 0;

    timeDisplay.textContent =
        `左 ${formatTime(Math.min(pos, leftDur))} / ${formatTime(leftDur)}　` +
        `右 ${formatTime(Math.min(pos, rightDur))} / ${formatTime(rightDur)}`;

    // シークバーを操作中は、こちらから値を書き換えない
    if (!isSeeking) {
        seekBar.max = duration || 100;
        seekBar.value = pos;
    }
}

// 0.1秒ごとに画面を更新
setInterval(updateUI, 100);


// ===== ファイルの読み込み =====

// Safariの古い版はPromise版のdecodeAudioDataが無いので、両対応にしておく
function decodeAudio(arrayBuffer) {
    return new Promise(function(resolve, reject) {
        const p = audioContext.decodeAudioData(arrayBuffer, resolve, reject);
        if (p && p.catch) p.catch(reject);
    });
}

async function loadFile(input, track, name) {
    const file = input.files[0];
    if (!file) return;

    stopAll();
    console.log(`${name}音源:`, file.name, file.type, file.size);
    timeDisplay.textContent = `${name}音源を読み込み中…`;

    try {
        const arrayBuffer = await file.arrayBuffer();
        track.buffer = await decodeAudio(arrayBuffer);
        console.log(`${name}音源の長さ:`, track.buffer.duration);
    } catch (e) {
        track.buffer = null;
        console.error(`${name}音源の読み込みエラー:`, e);
        alert(`${name}音源を読み込めませんでした。別の形式（m4a / mp3 など）で試してください。`);
    }

    updateUI();
}

leftFile.addEventListener("change", function() {
    loadFile(leftFile, left, "左");
});

rightFile.addEventListener("change", function() {
    loadFile(rightFile, right, "右");
});


// ===== 再生・一時停止・ループ再生 =====

// useLoop: false=通常再生、true=ループ再生
async function togglePlay(useLoop) {
    if (isPlaying) {
        if (useLoop === loopMode) {
            // 同じボタンをもう一度押した → 一時停止
            pauseAll();
            return;
        }
        // 別のモードのボタンを押した → 今の位置を覚えて切り替える
        offset = getPosition();
        stopSources();
        isPlaying = false;
    }

    if (getDuration() === 0) {
        alert("先に音源を選択してください");
        return;
    }

    if (useLoop) {
        const start = Number(loopStart.value);
        const end = Math.min(Number(loopEnd.value), getDuration());
        if (!(end > start)) {
            alert("ループの終了は、開始より後（曲の長さ以内）にしてください");
            return;
        }
        loopRange = { start: start, end: end };
        offset = start;
    }

    // iPhoneではボタンを押した操作の中で resume する必要がある
    await audioContext.resume();

    loopMode = useLoop;
    startSources();
    updateButtons();
}

playButton.addEventListener("click", function() {
    togglePlay(false);
});

loopPlayButton.addEventListener("click", function() {
    togglePlay(true);
});

stopButton.addEventListener("click", function() {
    stopAll();
});


// ===== 戻る・進む・同期 =====

backButton.addEventListener("click", function() {
    seekTo(getPosition() - Number(skipTime.value));
});

forwardButton.addEventListener("click", function() {
    seekTo(getPosition() + Number(skipTime.value));
});

// 左右は同じ時計で動いているのでズレないが、念のため今の位置から鳴らし直す
syncButton.addEventListener("click", function() {
    if (isPlaying) {
        offset = getPosition();
        startSources();
    }
});

function updateSkipButtonText() {
    backButton.textContent = `↩ ${skipTime.value}秒戻る`;
    forwardButton.textContent = `↪ ${skipTime.value}秒進む`;
}


// ===== シークバー =====
// 操作中は表示だけ動かし、指を離したときに実際に移動する
seekBar.step = "0.1";

seekBar.addEventListener("input", function() {
    isSeeking = true;
    const pos = Number(seekBar.value);
    timeDisplay.textContent =
        `左 ${formatTime(Math.min(pos, left.buffer?.duration ?? 0))} / ${formatTime(left.buffer?.duration ?? 0)}　` +
        `右 ${formatTime(Math.min(pos, right.buffer?.duration ?? 0))} / ${formatTime(right.buffer?.duration ?? 0)}`;
});

seekBar.addEventListener("change", function() {
    isSeeking = false;
    seekTo(Number(seekBar.value));
});


// ===== 再生速度 =====
// 注意：この方式では速度を変えると音程も一緒に変わる（テープの早回しと同じ）
playbackRate.addEventListener("change", function() {
    if (isPlaying) {
        offset = getPosition();
        startSources();
    }
    localStorage.setItem("playbackRate", playbackRate.value);
});


// ===== 画面の切り替え =====

// ループ設定の開閉
loopSettingsButton.addEventListener("click", function() {
    const isHidden = getComputedStyle(loopControls).display === "none";
    loopControls.style.display = isHidden ? "block" : "none";
});

// 設定パネルの開閉
settingsButton.addEventListener("click", function() {
    const opening = getComputedStyle(settingsPanel).display === "none";
    settingsPanel.style.display = opening ? "block" : "none";

    document.querySelectorAll(".audio-section, .controls, #timeDisplay, .seek-row")
        .forEach(element => element.style.display = opening ? "none" : "");
});


// ===== 設定の保存と復元 =====
skipTime.value = localStorage.getItem("skipTime") ?? 5;
volumeStep.value = localStorage.getItem("volumeStep") ?? 0.1;
loopStart.value = localStorage.getItem("loopStart") ?? 0;
loopEnd.value = localStorage.getItem("loopEnd") ?? 10;
leftVolume.value = localStorage.getItem("leftVolume") ?? 1;
rightVolume.value = localStorage.getItem("rightVolume") ?? 1;
playbackRate.value = localStorage.getItem("playbackRate") ?? 1;

skipTime.addEventListener("change", function() {
    localStorage.setItem("skipTime", skipTime.value);
    updateSkipButtonText();
});

volumeStep.addEventListener("change", function() {
    localStorage.setItem("volumeStep", volumeStep.value);
});

loopStart.addEventListener("change", function() {
    localStorage.setItem("loopStart", loopStart.value);
});

loopEnd.addEventListener("change", function() {
    localStorage.setItem("loopEnd", loopEnd.value);
});


// ===== 音量（スライダー・ボタン共通） =====
// 音量は GainNode で操作する（iPhoneでは audio.volume が効かないため）
function bindVolume(slider, downButton, upButton, track, storageKey) {
    // 0.05刻みなどの調整幅でも値がずれないように、スライダーの刻みを細かくしておく
    slider.step = "0.01";

    function apply(value) {
        value = Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
        slider.value = value;
        track.gain.gain.value = value;
        localStorage.setItem(storageKey, value);
    }

    slider.addEventListener("input", function() {
        apply(Number(slider.value));
    });
    downButton.addEventListener("click", function() {
        apply(Number(slider.value) - Number(volumeStep.value));
    });
    upButton.addEventListener("click", function() {
        apply(Number(slider.value) + Number(volumeStep.value));
    });

    // 保存されていた音量を反映
    apply(Number(slider.value));
}

bindVolume(leftVolume, leftVolumeDown, leftVolumeUp, left, "leftVolume");
bindVolume(rightVolume, rightVolumeDown, rightVolumeUp, right, "rightVolume");


// ===== 起動時の初期表示 =====
updateSkipButtonText();
updateButtons();
updateUI();