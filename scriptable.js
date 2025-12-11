/**
 * Designed to run in the Scriptable iOS app
 * Sync a Spotify playlist to a YouTube playlist (best-match search).
 * iPhone-friendly, runs in Scriptable.
 * - First run: prompts for Spotify & Google OAuth details and obtains refresh tokens, storing all in Keychain.
 * - Subsequent runs: just works.
 *
 * Notes:
 * - YouTube Music has no public API; this uses YouTube Data API v3.
 * - Scopes required (Google): youtube, youtube.force-ssl
 * - Scopes required (Spotify): playlist-read-private (and/ or playlist-read-collaborative if needed)
 *
 * Author: you + ChatGPT
 */

/*** ==== CONFIG (edit these) ==== ***/
const CONFIG = {
  SPOTIFY_SOURCE_PLAYLIST_ID: "YOUR_SPOTIFY_PLAYLIST_ID",  // e.g. 37i9dQZF1DXcBWIGoYBM5M
  YOUTUBE_TARGET_PLAYLIST_TITLE: "My Spotify → YouTube Sync",

  // If you already know your client IDs/secrets, you can paste them here; otherwise you'll be prompted once.
  SPOTIFY_CLIENT_ID: "",
  SPOTIFY_CLIENT_SECRET: "",
  GOOGLE_CLIENT_ID: "",
  GOOGLE_CLIENT_SECRET: "",

  // Tune search matching
  MAX_TRACKS: 500,               // safety cap
  YT_SEARCH_MAX_RESULTS: 5,      // try a few candidates for better matching
  DRY_RUN: false                 // true: log what would happen, don’t write to YouTube
};
/*** ==== END CONFIG ==== ***/

/*** ==== Simple storage helpers ==== ***/
const K = Keychain;
const store = {
  get: (k) => K.contains(k) ? K.get(k) : null,
  set: (k, v) => K.set(k, v),
  need: async (k, prompt, secret=false) => {
    let v = store.get(k);
    if (!v) {
      v = await promptFor(k, prompt, secret);
      store.set(k, v);
    }
    return v;
  }
};

async function promptFor(key, message, isSecret=false) {
  const a = new Alert();
  a.title = "Setup";
  a.message = message;
  a.addAction("OK");
  a.addCancelAction("Cancel");
  isSecret ? a.addSecureTextField("Enter value") : a.addTextField("Enter value");
  const i = await a.presentAlert();
  if (i === -1) throw new Error("Setup cancelled.");
  return a.textFieldValue(0).trim();
}

/*** ==== OAuth flows (manual but iPhone-friendly) ==== ***/
async function ensureSecrets() {
  // Spotify
  let spClientId = CONFIG.SPOTIFY_CLIENT_ID || store.get("sp_client_id") || "";
  let spClientSecret = CONFIG.SPOTIFY_CLIENT_SECRET || store.get("sp_client_secret") || "";

  if (!spClientId) {
    spClientId = await promptFor("sp_client_id", "Enter Spotify CLIENT_ID");
    store.set("sp_client_id", spClientId);
  }
  if (!spClientSecret) {
    spClientSecret = await promptFor("sp_client_secret", "Enter Spotify CLIENT_SECRET", true);
    store.set("sp_client_secret", spClientSecret);
  }

  // Google
  let gClientId = CONFIG.GOOGLE_CLIENT_ID || store.get("g_client_id") || "";
  let gClientSecret = CONFIG.GOOGLE_CLIENT_SECRET || store.get("g_client_secret") || "";
  if (!gClientId) {
    gClientId = await promptFor("g_client_id", "Enter Google (YouTube) CLIENT_ID");
    store.set("g_client_id", gClientId);
  }
  if (!gClientSecret) {
    gClientSecret = await promptFor("g_client_secret", "Enter Google (YouTube) CLIENT_SECRET", true);
    store.set("g_client_secret", gClientSecret);
  }
}

async function getSpotifyAccessToken() {
  const refresh = await getSpotifyRefreshToken();
  const clientId = store.get("sp_client_id");
  const clientSecret = store.get("sp_client_secret");

  const resp = await httpPostForm("https://accounts.spotify.com/api/token", {
    grant_type: "refresh_token",
    refresh_token: refresh
  }, {
    Authorization: "Basic " + btoa(`${clientId}:${clientSecret}`),
    "Content-Type": "application/x-www-form-urlencoded"
  });
  if (!resp.access_token) throw new Error("Spotify token refresh failed");
  return resp.access_token;
}

async function getSpotifyRefreshToken() {
  let rt = store.get("sp_refresh_token");
  if (rt) return rt;

  const clientId = store.get("sp_client_id");
  const redirectUri = "scriptable://callback"; // use custom scheme capture method
  const scopes = encodeURIComponent("playlist-read-private playlist-read-collaborative");
  const authUrl =
    `https://accounts.spotify.com/authorize?response_type=code&client_id=${clientId}` +
    `&scope=${scopes}&redirect_uri=${encodeURIComponent(redirectUri)}`;

  // Guide user to tap OK, open URL, then after redirect Scriptable will reopen with full URL. We'll paste it.
  await messageBox(
    "Spotify Auth",
    "You'll be taken to Spotify to authorize.\nAfter granting access, you'll land back in Scriptable with a URL — copy that URL and paste it in the next prompt."
  );
  Safari.open(authUrl);
  await sleep(3000);
  const redirectFull = await promptFor("sp_redirect", "Paste the FULL redirected URL from Scriptable after Spotify login");
  const code = getQueryParam(redirectFull, "code");
  if (!code) throw new Error("No code found in redirected URL.");

  const clientSecret = store.get("sp_client_secret");
  const tokenResp = await httpPostForm("https://accounts.spotify.com/api/token", {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri
  }, {
    Authorization: "Basic " + btoa(`${clientId}:${clientSecret}`),
    "Content-Type": "application/x-www-form-urlencoded"
  });

  if (!tokenResp.refresh_token) throw new Error("Failed to obtain Spotify refresh token.");
  store.set("sp_refresh_token", tokenResp.refresh_token);
  return tokenResp.refresh_token;
}

async function getGoogleAccessToken() {
  const refresh = await getGoogleRefreshToken();
  const clientId = store.get("g_client_id");
  const clientSecret = store.get("g_client_secret");

  const resp = await httpPostForm("https://oauth2.googleapis.com/token", {
    grant_type: "refresh_token",
    refresh_token: refresh,
    client_id: clientId,
    client_secret: clientSecret
  });
  if (!resp.access_token) throw new Error("Google token refresh failed");
  return resp.access_token;
}

async function getGoogleRefreshToken() {
  let rt = store.get("g_refresh_token");
  if (rt) return rt;

  const clientId = store.get("g_client_id");
  const redirectUri = "urn:ietf:wg:oauth:2.0:oob";
  const scope = encodeURIComponent("https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/youtube.force-ssl");
  const authUrl =
    `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}&access_type=offline&prompt=consent`;

  await messageBox(
    "Google/YouTube Auth",
    "You'll be taken to Google to authorize YouTube access.\nAfter granting access, you'll land back in Scriptable with a URL — copy that URL and paste it in the next prompt."
  );
  Safari.open(authUrl);
  await sleep(3000);
  const redirectFull = await promptFor("g_redirect", "Paste the FULL redirected URL from Scriptable after Google login");
  const code = getQueryParam(redirectFull, "code");
  if (!code) throw new Error("No code found in redirected URL.");

  const clientSecret = store.get("g_client_secret");
  const tokenResp = await httpPostForm("https://oauth2.googleapis.com/token", {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret
  });

  if (!tokenResp.refresh_token) throw new Error("Failed to obtain Google refresh token.");
  store.set("g_refresh_token", tokenResp.refresh_token);
  return tokenResp.refresh_token;
}

/*** ==== HTTP helpers ==== ***/
async function httpGet(url, headers={}) {
  const req = new Request(url);
  Object.entries(headers).forEach(([k,v]) => req.headers[k] = v);
  req.method = "GET";
  return await req.loadJSON();
}
async function httpPost(url, body, headers={}) {
  const req = new Request(url);
  Object.entries(headers).forEach(([k,v]) => req.headers[k] = v);
  req.method = "POST";
  req.body = body ? JSON.stringify(body) : null;
  return await req.loadJSON();
}
async function httpPostForm(url, formObj, headers={}) {
  const req = new Request(url);
  Object.entries(headers).forEach(([k,v]) => req.headers[k] = v);
  req.method = "POST";
  req.headers["Content-Type"] = req.headers["Content-Type"] || "application/x-www-form-urlencoded";
  req.body = new URLSearchParams(formObj).toString();
  return await req.loadJSON();
}
function btoa(str){ return Data.fromString(str).toBase64String(); }
// Scriptable doesn’t expose setTimeout; use Timer to delay.
function sleep(ms){
  return new Promise((resolve) => Timer.schedule(ms / 1000, false, resolve));
}
// Scriptable lacks a global URL parser; minimal query extractor for OAuth redirects.
function getQueryParam(url, name) {
  const qIndex = url.indexOf("?");
  if (qIndex === -1) return null;
  const query = url.slice(qIndex + 1);
  for (const part of query.split("&")) {
    if (!part) continue;
    const [k, v = ""] = part.split("=");
    if (decodeURIComponent(k) === name) return decodeURIComponent(v.replace(/\+/g, " "));
  }
  return null;
}
async function messageBox(title, message) {
  const a = new Alert();
  a.title = title;
  a.message = message;
  a.addAction("OK");
  await a.presentAlert();
}

/*** ==== Spotify: read tracks from a playlist ==== ***/
async function getSpotifyPlaylistTracks(spAccessToken, playlistId, limit=100) {
  let url = `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/tracks?limit=${limit}`;
  const items = [];
  while (url && items.length < CONFIG.MAX_TRACKS) {
    const page = await httpGet(url, { Authorization: `Bearer ${spAccessToken}` });
    for (const it of page.items || []) {
      if (it.track && it.track.name && it.track.artists?.length) {
        items.push({
          name: it.track.name,
          artists: it.track.artists.map(a=>a.name),
          album: it.track.album?.name || ""
        });
      }
    }
    url = page.next;
  }
  return items;
}

/*** ==== YouTube: find/create playlist, add items ==== ***/
async function ensureYouTubePlaylist(ytAccessToken, title) {
  // Try to find existing by title
  const listResp = await httpGet("https://www.googleapis.com/youtube/v3/playlists?part=snippet&mine=true&maxResults=50", {
    Authorization: `Bearer ${ytAccessToken}`
  });
  const found = (listResp.items||[]).find(p => (p.snippet?.title||"").toLowerCase() === title.toLowerCase());
  if (found) return found.id;

  if (CONFIG.DRY_RUN) return "DRY_RUN_PLAYLIST_ID";

  // Create
  const createResp = await httpPost("https://www.googleapis.com/youtube/v3/playlists?part=snippet,status", {
    snippet: { title },
    status: { privacyStatus: "private" }
  }, { Authorization: `Bearer ${ytAccessToken}`, "Content-Type":"application/json" });

  if (!createResp.id) throw new Error("Failed to create YouTube playlist.");
  return createResp.id;
}

async function getYouTubePlaylistVideoIds(ytAccessToken, playlistId) {
  const ids = new Set();
  let pageToken = "";
  do {
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&playlistId=${playlistId}&maxResults=50${pageToken?`&pageToken=${pageToken}`:""}`;
    const resp = await httpGet(url, { Authorization: `Bearer ${ytAccessToken}` });
    for (const it of (resp.items||[])) {
      const vid = it.contentDetails?.videoId;
      if (vid) ids.add(vid);
    }
    pageToken = resp.nextPageToken;
  } while (pageToken);
  return ids;
}

function buildSearchQuery(track) {
  // "Song - Artist1, Artist2" + album as hint
  const artists = track.artists.join(", ");
  return `${track.name} - ${artists}`;
}

function scoreCandidate(title, channelTitle, query) {
  // crude heuristic score
  const t = (title||"").toLowerCase();
  const ch = (channelTitle||"").toLowerCase();
  const q = query.toLowerCase();

  let score = 0;
  if (t.includes(q)) score += 5;
  if (q.split(/\s+/).every(w=>t.includes(w))) score += 3;
  if (/topic$/.test(ch)) score += 2; // official auto-gen music channel
  if (/official.*video|audio|lyric/.test(t)) score += 1;
  return score;
}

async function searchYouTubeBestMatch(ytAccessToken, query) {
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=${CONFIG.YT_SEARCH_MAX_RESULTS}&q=${encodeURIComponent(query)}`;
  const resp = await httpGet(url, { Authorization: `Bearer ${ytAccessToken}` });
  const items = resp.items || [];
  if (!items.length) return null;

  let best = null;
  let bestScore = -1;
  for (const it of items) {
    const title = it.snippet?.title || "";
    const channelTitle = it.snippet?.channelTitle || "";
    const s = scoreCandidate(title, channelTitle, query);
    if (s > bestScore) {
      best = it;
      bestScore = s;
    }
  }
  return best?.id?.videoId || null;
}

async function addToYouTubePlaylist(ytAccessToken, playlistId, videoId) {
  const url = "https://www.googleapis.com/youtube/v3/playlistItems?part=snippet";
  const body = { snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } } };
  return await httpPost(url, body, {
    Authorization: `Bearer ${ytAccessToken}`,
    "Content-Type": "application/json"
  });
}

/*** ==== Main ==== ***/
(async () => {
  try {
    await ensureSecrets();

    const spToken = await getSpotifyAccessToken();
    const ytToken = await getGoogleAccessToken();

    const tracks = await getSpotifyPlaylistTracks(spToken, CONFIG.SPOTIFY_SOURCE_PLAYLIST_ID);
    if (!tracks.length) { await messageBox("Done", "No tracks found in the Spotify playlist."); return; }

    const ytPlaylistId = await ensureYouTubePlaylist(ytToken, CONFIG.YOUTUBE_TARGET_PLAYLIST_TITLE);

    const existing = ytPlaylistId === "DRY_RUN_PLAYLIST_ID"
      ? new Set()
      : await getYouTubePlaylistVideoIds(ytToken, ytPlaylistId);

    let added = 0, skipped = 0, failed = 0;
    for (const track of tracks) {
      const q = buildSearchQuery(track);
      const vid = await searchYouTubeBestMatch(ytToken, q);
      if (!vid) { failed++; continue; }
      if (existing.has(vid)) { skipped++; continue; }
      if (!CONFIG.DRY_RUN) {
        try {
          await addToYouTubePlaylist(ytToken, ytPlaylistId, vid);
          existing.add(vid);
          added++;
        } catch (e) { failed++; }
      } else {
        added++;
      }
    }

    await messageBox("Sync complete",
      `Processed: ${tracks.length}\nAdded: ${added}\nSkipped (dupes): ${skipped}\nFailed to match: ${failed}\n` +
      (CONFIG.DRY_RUN ? "Mode: DRY RUN (no changes written)" : "")
    );

  } catch (e) {
    const a = new Alert();
    a.title = "Error";
    a.message = String(e && e.message || e);
    a.addAction("OK");
    await a.presentAlert();
  }
})();
