/**
 * player.js — thin wrapper around the official YouTube IFrame Player API.
 *
 * We never download or re-host videos: the original YouTube player is embedded (privacy-friendly
 * youtube-nocookie host) and controlled through its API (seek, play, current time).
 * Note: the browser cannot read the player's pixels (cross-origin). Everything we "see" in the video
 * therefore comes from Gemini's analysis, not from frame grabbing.
 *
 * The player starts MUTED (project rule: tests and demos are silent unless sound is wanted).
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
    this.t = 0; this.yt = null; this.paused = true;
    host.innerHTML = `<img class="poster" alt="" src="https://i.ytimg.com/vi/${videoId}/hqdefault.jpg"><div class="yt"></div>`;
    loadApi().then((YT) => {
      this.yt = new YT.Player(host.querySelector(".yt"), {
        host: "https://www.youtube-nocookie.com", videoId,
        playerVars: { rel: 0, modestbranding: 1, playsinline: 1, mute: 1 },
        events: {
          onReady: () => { this.yt.mute(); host.querySelector(".poster")?.remove(); },
          onStateChange: (e) => { this.paused = e.data !== YT.PlayerState.PLAYING; this.onState(this.paused, e.data); },
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
    if (this.yt?.seekTo) { this.yt.seekTo(t, true); play ? this.yt.playVideo() : this.yt.pauseVideo(); }
  }
  destroy() { clearInterval(this.timer); try { this.yt?.destroy?.(); } catch { /* ignore */ } }
}
