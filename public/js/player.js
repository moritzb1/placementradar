/**
 * player.js — thin wrapper around the official YouTube IFrame Player API.
 *
 * We never download or re-host videos: the original YouTube player is embedded (privacy-friendly
 * youtube-nocookie host) and controlled through its API (seek, play, current time).
 * Note: the browser cannot read the player's pixels (cross-origin). Everything we "see" in the video
 * therefore comes from Gemini's analysis, not from frame grabbing.
 *
 * The player starts MUTED (project rule: tests and demos are silent unless sound is wanted).
 *
 * Black frame after a jump: an embedded player that has never played shows black when it is seeked while
 * paused (nothing decoded yet). The first paused seek therefore "nudges" it: play muted until the first
 * frame arrives, pause, seek back to the exact time. The nudge is invisible to the app (no state events).
 */
let apiReady = null;
function loadApi() {
  if (apiReady) return apiReady;
  apiReady = new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT);
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    s.onerror = () => reject(new Error("YouTube API not reachable"));
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    document.head.appendChild(s);
    setTimeout(() => reject(new Error("YouTube API timeout")), 8000);
  });
  return apiReady;
}

export class Player {
  /** @param {HTMLElement} host element that will contain the iframe */
  constructor(host, videoId, { onState = () => {}, onTime = () => {} } = {}) {
    this.host = host; this.id = videoId; this.onState = onState; this.onTime = onTime;
    this.t = 0; this.yt = null; this.paused = true; this.hasPlayed = false; this.nudgeTo = null;
    host.innerHTML = `<img class="poster" alt="" src="https://i.ytimg.com/vi/${videoId}/hqdefault.jpg"><div class="yt"></div>`;
    loadApi().then((YT) => {
      this.yt = new YT.Player(host.querySelector(".yt"), {
        host: "https://www.youtube-nocookie.com", videoId,
        playerVars: { rel: 0, modestbranding: 1, playsinline: 1, mute: 1 },
        events: {
          onReady: () => { this.yt.mute(); host.querySelector(".poster")?.remove(); },
          onStateChange: (e) => {
            if (e.data === YT.PlayerState.PLAYING) this.hasPlayed = true;
            if (this.nudgeTo != null) { // first frame is decoded → stop again at the wanted time, app sees nothing
              if (e.data === YT.PlayerState.PLAYING) { const t = this.nudgeTo; this.nudgeTo = null; this.yt.pauseVideo(); this.yt.seekTo(t, true); }
              return;
            }
            this.paused = e.data !== YT.PlayerState.PLAYING; this.onState(this.paused, e.data);
          },
        },
      });
      this.timer = setInterval(() => {
        const t = this.yt?.getCurrentTime?.();
        if (typeof t === "number" && Math.abs(t - this.t) > 0.05) { this.t = t; this.onTime(t); }
      }, 250);
    }).catch(() => { /* offline: poster image stays, seeking just updates our playhead */ });
  }
  seek(t, play = false) {
    this.t = t; this.onTime(t);
    if (!this.yt?.seekTo) return;
    this.yt.seekTo(t, true);
    this.yt.mute?.(); // always silent before anything plays (project rule: tests and demos never make a sound)
    if (play) { this.nudgeTo = null; this.yt.playVideo(); }
    else if (!this.hasPlayed) { this.nudgeTo = t; this.yt.playVideo(); setTimeout(() => { if (this.nudgeTo != null) { this.nudgeTo = null; this.yt.pauseVideo?.(); } }, 4000); }
    else this.yt.pauseVideo();
  }
  destroy() { clearInterval(this.timer); try { this.yt?.destroy?.(); } catch { /* ignore */ } }
}
