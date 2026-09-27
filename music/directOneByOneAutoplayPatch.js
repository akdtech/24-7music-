"use strict";

/* DEATH Music — one-at-a-time related autoplay. */
const { spawn } = require("node:child_process");
const MusicManager = require("./DirectMusicManager");

const YTDLP = process.env.YTDLP_PATH || "/usr/local/bin/yt-dlp";
const MAX_TRACK_MS = 8 * 60 * 1000;
const RECENT_LIMIT = 25;
const BAD = /\b(playlist|mix|compilation|full album|album mix|nonstop|continuous|radio|medley|hour mix|meg[a -]?mix|collection|reaction|review|podcast|karaoke|cover)\b/i;

const clean = v => String(v || "").replace(/\s+/g, " ").trim();
const norm = v => clean(v).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const idOf = t => t?.identifier || t?.id || t?.url;
const artistOf = t => clean(t?.author || t?.uploader || t?.channel);

function sameArtist(a,b) {
  const x=norm(a), y=norm(b);
  return !!x && !!y && (x===y || x.includes(y) || y.includes(x));
}

function search(query) {
  return new Promise((resolve,reject)=>{
    const child=spawn(YTDLP,[
      "--no-warnings","--no-progress","--no-playlist","--flat-playlist",
      "--playlist-end","12","--js-runtimes","node",
      "--extractor-args","youtube:player_client=web_music,web_embedded",
      "--remote-components","ejs:github",
      "--dump-single-json",
      "ytsearch12:"+clean(query)
    ],{stdio:["ignore","pipe","pipe"]});

    let out="",err="",done=false;
    const timer=setTimeout(()=>{try{child.kill("SIGKILL")}catch{}; if(!done){done=true;reject(new Error("autoplay search timeout"))}},12000);
    child.stdout.on("data",c=>out+=c.toString());
    child.stderr.on("data",c=>err+=c.toString());
    child.on("error",e=>{if(done)return;done=true;clearTimeout(timer);reject(e)});
    child.on("close",code=>{
      if(done)return; done=true; clearTimeout(timer);
      if(code!==0)return reject(new Error(clean(err).slice(-1200)||"YouTube autoplay search failed"));
      try{resolve(JSON.parse(out||"{}")?.entries||[])}catch(e){reject(e)}
    });
  });
}

function toTrack(entry, requester) {
  if(!entry?.id || !entry?.title) return null;
  return {
    identifier:entry.id,
    id:entry.id,
    url:"https://www.youtube.com/watch?v="+entry.id,
    title:clean(entry.title),
    author:clean(entry.uploader||entry.channel||entry.creator)||"Unknown artist",
    length:Number(entry.duration||0)*1000,
    requester:requester||null,
    thumbnail:entry.thumbnail||"https://i.ytimg.com/vi/"+entry.id+"/hqdefault.jpg",
    source:"youtube",
    isAutoplay:true
  };
}

async function findNext(manager,state) {
  const ctx=state.autoplayContext||{};
  const artist=clean(ctx.artist||ctx.author);
  const title=clean(ctx.title);
  const query=clean(ctx.query);
  const seeds=[];

  if(artist){
    seeds.push(artist+" official songs");
    seeds.push(artist+" songs official audio");
    seeds.push(artist+" similar songs official audio");
  }
  if(query){
    seeds.push(query+" similar songs official audio");
  }
  if(title){
    seeds.push(title+" related songs official audio");
  }
  if(!seeds.length){
    seeds.push("popular songs official audio");
    seeds.push("trending songs official audio");
  }

  const recent=new Set(Array.isArray(state.recent)?state.recent:[]);
  if(state.current)recent.add(idOf(state.current));

  const candidates=[];
  for(const seed of [...new Set(seeds)].slice(0,4)){
    try{
      const entries=await search(seed);
      for(const e of entries){
        const t=toTrack(e,manager.client.user);
        if(!t || BAD.test(t.title) || t.length<=0 || t.length>MAX_TRACK_MS) continue;
        if(recent.has(idOf(t))) continue;

        const hay=norm(t.title+" "+artistOf(t));
        const wanted=norm(title+" "+query);
        let score=0;
        if(artist && sameArtist(artistOf(t),artist)) score+=300;
        for(const w of norm(wanted).split(" ").filter(x=>x.length>=3)){
          if(hay.includes(w)) score+=10;
        }
        if(/\b(official|vevo|topic)\b/i.test(artistOf(t))) score+=5;
        candidates.push({t,score});
      }
    }catch(e){
      console.warn("⚠️ Related autoplay search failed:",e?.message||e);
    }
  }

  candidates.sort((a,b)=>b.score-a.score);
  return candidates[0]?.t||null;
}

if(!MusicManager.prototype.__deathOneByOneAutoplay){
  MusicManager.prototype.__deathOneByOneAutoplay=true;

  MusicManager.prototype.autoplayNext=async function oneByOneAutoplay(guildId){
    const state=this.getState(guildId);
    const player=this.players.get(guildId)||this.ensurePlayer(guildId);

    if(!state.autoplay || state.intentionalLeave || state.autoplayBusy) return false;
    if(state.current || state.queue.length) return false;

    state.autoplayBusy=true;
    try{
      const next=await findNext(this,state);
      if(!next) {
        console.warn("⚠️ No related YouTube track found; retrying on the next recovery cycle.");
        return false;
      }

      next.isAutoplay=true;
      next.autoplayGroup=state.autoplayContext?.artist
        ? "Same artist / related"
        : "Related music";

      const id=idOf(next);
      if(id) state.recent=[...(state.recent||[]),id].slice(-RECENT_LIMIT);

      await this.startTrack(guildId,next,0,{handoff:true});
      state.queue=[];
      state.transitioning=false;

      console.log("♾️ 24/7 autoplay: "+this.getTrackTitle(next)+" — "+artistOf(next));
      return true;
    }catch(error){
      state.current=null;
      state.transitioning=false;
      console.warn("⚠️ 24/7 autoplay track failed:",error?.message||error);
      return false;
    }finally{
      state.autoplayBusy=false;
    }
  };

  console.log("♾️ DEATH one-by-one autoplay loaded: same artist/related genre, no playlist queue.");
}
