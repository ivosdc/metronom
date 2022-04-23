<script>
    import {icon_play, icon_pause, sound_tock} from './AssetService';

    let bpm = 100;
    let mute = true;

    function startSounddevice() {
        if (!mute) {
            setTimeout(() => {
                let audio = new Audio(sound_tock);
                if (!mute) { // avoids playing the last sound after muting.
                    audio.play();
                }
                startSounddevice();
            }, Math.round((1000 * 60) / bpm));
        }
    }

    function toggleMute() {
        mute = !mute;
        if (!mute) {
            startSounddevice();
        }
    }

</script>

<div class="metronom-body">
    <div class="block">{bpm} bpm</div>
    <div class="block">
        <input class="metronom-slider" bind:value={bpm} type="range" min="40" max="256" step="1">
    </div>
    <div class="block" on:click={toggleMute}>{@html mute ? icon_play : icon_pause}</div>
</div>
<style>
    .metronom-slider {
        padding: 0.5em 0;
    }

    .metronom-body {
        display: grid;
        grid-template-columns: auto;
    }

    .block {
        font-family: Calibri, Candara, Arial, Helvetica, sans-serif;
        font-size: x-large;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
    }

</style>