// HTMLから部品を取得する
// Web Audio APIを使うための音声処理システム
const audioContext = new AudioContext();

// 音声を再生するためのAudioオブジェクト
let leftAudio = null;
let rightAudio = null;

//HTMLの中から、originalFileというidを持っている要素を探して持ってきて
const leftFile = document.getElementById("leftFile");
const rightFile = document.getElementById("rightFile");

//再生・停止・同期のやつ
const playButton = document.getElementById("playButton");
const stopButton = document.getElementById("stopButton");
const syncButton = document.getElementById("syncButton");
//スキップとかのやつ
const backButton = document.getElementById("backButton");
const forwardButton = document.getElementById("forwardButton");

//再生時間のやつ
const timeDisplay = document.getElementById("timeDisplay");
//再生バー
const seekBar = document.getElementById("seekBar");
//ループ再生のやつ（判別値も添えて）
const loopStart = document.getElementById("loopStart");
const loopEnd = document.getElementById("loopEnd");

const loopSettingsButton = document.getElementById("loopSettingsButton");
const loopPlayButton = document.getElementById("loopPlayButton");

const loopControls = document.getElementById("loopControls");
let isLoopPlaying = false;

//音量調節のやつ
const leftVolume = document.getElementById("leftVolume");
const rightVolume = document.getElementById("rightVolume");


//設定ボタンのやつ
const settingsButton = document.getElementById("settingsButton");
const settingsPanel = document.getElementById("settingsPanel");

//スキップ時間の幅・音量の調整の入力のやつ
const skipTime = document.getElementById("skipTime");
const volumeStep = document.getElementById("volumeStep");

//音量調整ボタンのやつ（左右）
const leftVolumeDown = document.getElementById("leftVolumeDown");
const leftVolumeUp = document.getElementById("leftVolumeUp");

const rightVolumeDown = document.getElementById("rightVolumeDown");
const rightVolumeUp = document.getElementById("rightVolumeUp");

//再生速度のやつ
const playbackRate = document.getElementById("playbackRate");

//ボタン切り替えのやつ
let isPlaying = false;

//Unityと違い、アタッチがない分自分で参照して保存する必要があるのかも
//documentはhtmlにあるものを指しているらしい

//addEventはｘｘされたら実行の定義、今回はclickとあるので（これも固有のイベント）押されたときに実行
//functionは関数という認識でOK今回は名前のない関数で使っているらしい？

//再生ボタン
playButton.addEventListener("click", function() {
    console.log("再生ボタンが押されました！");
    if (!isPlaying) {
        //再生機能
        if (!isPlaying) {
        audioContext.resume();  // playより先に呼ぶ

        if (leftAudio) {//デバックの分も
            leftAudio.play().catch(e => console.error("左音源エラー:", e));
        }
        if (rightAudio) {
            rightAudio.play().catch(e => console.error("右音源エラー:", e));
        }

        isPlaying = true;
        playButton.textContent = "⏸ 一時停止";
    }
    }else{
        //一時停止機能
            if (leftAudio) {
                leftAudio.pause();
            }

            if (rightAudio) {
                rightAudio.pause();
            }
        isPlaying=false;
        playButton.textContent = "▶ 再生";
    }

});


//停止ボタン（というよりリセットボタン）
stopButton.addEventListener("click", function() {
    console.log("停止ボタンが押されました！");

    if (leftAudio) {
        leftAudio.pause();
        leftAudio.currentTime = 0;
    }

    if (rightAudio) {
        rightAudio.pause();
        rightAudio.currentTime = 0;
    }
    isPlaying=false;
    playButton.textContent = "▶ 再生";
});
//5秒戻すボタン
backButton.addEventListener("click", function() {
    if (leftAudio) {
        leftAudio.currentTime = Math.max(0,
        leftAudio.currentTime - Number(skipTime.value)
    );
    }

    if (rightAudio) {
        rightAudio.currentTime = Math.max(0,
            rightAudio.currentTime - Number(skipTime.value)
        );
    }
});

//5秒スキップするボタン
forwardButton.addEventListener("click", function() {
    if (leftAudio) {
        leftAudio.currentTime = Math.min(
        leftAudio.duration,
        leftAudio.currentTime + Number(skipTime.value)
    );
    }

    if (rightAudio) {
        rightAudio.currentTime = Math.min(
        rightAudio.duration,
        rightAudio.currentTime + Number(skipTime.value)
    );
    }
});

//スキップボタンと同期
function updateSkipButtonText() {
    backButton.textContent = `↩ ${skipTime.value}秒戻る`;
    forwardButton.textContent = `↪ ${skipTime.value}秒進む`;
}

//同期するボタン
syncButton.addEventListener("click", function() {
    if (leftAudio && rightAudio) {
        rightAudio.currentTime = leftAudio.currentTime;
    }
});

//設定ボタンのやつ
settingsButton.addEventListener("click", function() {
    if (settingsPanel.style.display === "none") {
        settingsPanel.style.display = "block";

        document.querySelectorAll(".audio-section, .controls, #timeDisplay, .seek-row")
            .forEach(element => element.style.display = "none");

    } else {
        settingsPanel.style.display = "none";

        document.querySelectorAll(".audio-section, .controls, #timeDisplay, .seek-row")
            .forEach(element => element.style.display = "");
    }
});

//再生策度のやつ
playbackRate.addEventListener("change", function() {
    if (leftAudio) {
        leftAudio.playbackRate = Number(playbackRate.value);
    }

    if (rightAudio) {
        rightAudio.playbackRate = Number(playbackRate.value);
    }

    localStorage.setItem("playbackRate", playbackRate.value);
});


// 左音源が選択されたとき（デバック用）
leftFile.addEventListener("change", function() {
    const file = leftFile.files[0];

    if (file) {
        console.log("左音源:", file.name);
    }
});


// 右音源選択されたとき（デバック用）
rightFile.addEventListener("change", function() {
    const file = rightFile.files[0];

    if (file) {
        console.log("右音源:", file.name);
    }
    });

// 左音源が選択されたとき
leftFile.addEventListener("change", function() {
    const file = leftFile.files[0];

    if (file) {
        console.log("左音源:", file.name);


        //URL.はブラウザの中で一時的にアクセスできるものに変換するということ（）の中は参照
        const leftMedia = document.createElement(
            file.type.startsWith("video/") ? "video" : "audio"
        );
        //ビデオなら音声のみ取り出す
        leftMedia.src = URL.createObjectURL(file);
        leftMedia.playsInline = true;
        leftMedia.controls = false;

        leftAudio = leftMedia;
        leftAudio.volume = leftVolume.value;
        leftAudio.playbackRate = Number(playbackRate.value);

        //duration は音源の全体の長さ
        //loadedmetadata は、音源の長さなどの情報をブラウザが読み込めたときに発生する固有の関数（イベント）
        leftAudio.addEventListener("loadedmetadata", function() {
        console.log("左音源の長さ:", leftAudio.duration);
        });

        //動画時間の計算
        leftAudio.addEventListener("timeupdate", function() {
            timeDisplay.textContent =
            `左 ${formatTime(leftAudio.currentTime)} / ${formatTime(leftAudio.duration)}　` +
            `右 ${formatTime(rightAudio?.currentTime ?? 0)} / ${formatTime(rightAudio?.duration ?? 0)}`;
            //シークバーとの連動
            seekBar.max = leftAudio.duration;
            seekBar.value = leftAudio.currentTime;
            console.log(leftAudio.duration);

            //ループ再生が終わったら開始まで戻す
            if (isLoopPlaying && leftAudio.currentTime >= Number(loopEnd.value)) {
                leftAudio.currentTime = Number(loopStart.value);
            }
        });
        //leftAudio を Web Audio APIの処理対象にするための代入的なやつ
        const leftSource = audioContext.createMediaElementSource(leftAudio);

        //rightSource の出力を rightPanner に接続する
        const leftPanner = audioContext.createStereoPanner();
        
        //panは音を左右の音量を指定する値。
        //１が右100%,-1が左100%
        //ややこしいけど、左を充填して聞く場合は右を0とかにする感じ？
        //実質的な音量調整機能のあれだと思われる
        leftPanner.pan.value = -1;

        leftSource.connect(leftPanner);
        leftPanner.connect(audioContext.destination);
        }
        
        leftAudio.addEventListener("ended", function() {
            isPlaying = false;
            playButton.textContent = "▶ 再生";
            seekBar.value = seekBar.max;
        });
});


// 右音源が選択されたとき
rightFile.addEventListener("change", function() {
    const file = rightFile.files[0];

    if (file) {
        console.log("右音源:", file.name);

        const rightMedia = document.createElement(
            file.type.startsWith("video/") ? "video" : "audio"
        );

        rightMedia.src = URL.createObjectURL(file);
        rightMedia.playsInline = true;
        rightMedia.controls = false;

        rightAudio = rightMedia;
        rightAudio.volume = rightVolume.value;
        rightAudio.playbackRate = Number(playbackRate.value);

        rightAudio.addEventListener("loadedmetadata", function() {
            console.log("右音源の長さ:", rightAudio.duration);
        });

        rightAudio.addEventListener("timeupdate", function() {
            timeDisplay.textContent =
            `左 ${formatTime(leftAudio?.currentTime ?? 0)} / ${formatTime(leftAudio?.duration ?? 0)}　` +
            `右 ${formatTime(rightAudio.currentTime)} / ${formatTime(rightAudio.duration)}`;

            if (isLoopPlaying && rightAudio.currentTime >= Number(loopEnd.value)) {
                rightAudio.currentTime = Number(loopStart.value);
            }
        });

        const rightSource = audioContext.createMediaElementSource(rightAudio);
        const rightPanner = audioContext.createStereoPanner();

        rightPanner.pan.value = 1;

        rightSource.connect(rightPanner);
        rightPanner.connect(audioContext.destination);

        rightAudio.addEventListener("ended", function() {
            isPlaying = false;
            playButton.textContent = "▶ 再生";
        });
        }
});

//音量調整のやつ
leftVolume.addEventListener("input", function() {
    if (leftAudio) {
        leftAudio.volume = leftVolume.value;
    }
});

rightVolume.addEventListener("input", function() {
    if (rightAudio) {
        rightAudio.volume = rightVolume.value;
    }
});

//シークバーと実際の音源とを連動させる
seekBar.addEventListener("input", function() {
    if (leftAudio) {
        leftAudio.currentTime = seekBar.value;
    }

    if (rightAudio) {
        rightAudio.currentTime = seekBar.value;
    }
});

//ループ設定ボタン
loopSettingsButton.addEventListener("click", function() {
    if (loopControls.style.display === "none") {
        loopControls.style.display = "block";
    } else {
        loopControls.style.display = "none";
    }
});

//ループ設定専用の再生状態
loopPlayButton.addEventListener("click", function() {
    if (!isLoopPlaying) {
        if (leftAudio) {
            leftAudio.currentTime = Number(loopStart.value);
        }

        if (rightAudio) {
            rightAudio.currentTime = Number(loopStart.value);
        }

        audioContext.resume();

        if (leftAudio) {
            leftAudio.play();
        }

        if (rightAudio) {
            rightAudio.play();
        }

        isLoopPlaying = true;
        loopPlayButton.textContent = "■ 再生停止！";

    } else {
        if (leftAudio) {
            leftAudio.pause();
        }

        if (rightAudio) {
            rightAudio.pause();
        }

        isLoopPlaying = false;
        loopPlayButton.textContent = "▶ 再生開始！";
    }
});


//左の音量を下げる
leftVolumeDown.addEventListener("click", function() {
    if (leftAudio) {
        leftAudio.volume = Math.max(0, leftAudio.volume - Number(volumeStep.value));
        leftVolume.value = leftAudio.volume;
        localStorage.setItem("leftVolume", leftVolume.value);
    }
});
//左の音量を上げる
leftVolumeUp.addEventListener("click", function() {
    if (leftAudio) {
        leftAudio.volume = Math.min(1, leftAudio.volume + Number(volumeStep.value));
        leftVolume.value = leftAudio.volume;
        localStorage.setItem("leftVolume", leftVolume.value);
    }
});

//右の音量を下げる
rightVolumeDown.addEventListener("click", function() {
    if (rightAudio) {
        rightAudio.volume = Math.max(0, rightAudio.volume - Number(volumeStep.value));
        rightVolume.value = rightAudio.volume;
        localStorage.setItem("rightVolume", rightVolume.value);
    }
});

//右の音量を上げる
rightVolumeUp.addEventListener("click", function() {
    if (rightAudio) {
        rightAudio.volume = Math.min(1, rightAudio.volume + Number(volumeStep.value));
        rightVolume.value = rightAudio.volume;
        localStorage.setItem("rightVolume", rightVolume.value);
    }
});
//音源の時間を計算
function formatTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);

    return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

//設定の保存
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

leftVolume.addEventListener("change", function() {
    localStorage.setItem("leftVolume", leftVolume.value);
});

rightVolume.addEventListener("change", function() {
    localStorage.setItem("rightVolume", rightVolume.value);
});
updateSkipButtonText();

