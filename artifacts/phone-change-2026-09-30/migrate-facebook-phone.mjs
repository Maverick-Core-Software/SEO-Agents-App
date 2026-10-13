import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// One-off contact migration. Never creates/deletes posts or modifies media.
const root = process.cwd();
const out = path.dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const page = env.FB_PAGE_ID;
if (!['108252941997164', '100084297143688'].includes(page)) throw new Error('Unexpected target Page');
const token = env.FB_PAGE_ACCESS_TOKEN || env.FB_ACCESS_TOKEN;
if (!token) throw new Error('Page token unavailable');
const base = `https://graph.facebook.com/${env.FB_GRAPH_API_VERSION || 'v22.0'}/`;
const apply = process.argv.includes('--apply');
const collateral = process.argv.includes('--collateral');
const photos = process.argv.includes('--photos');
const videos = process.argv.includes('--videos');
if ((photos || videos) && apply) throw new Error('Media audit is read-only');
const oldPhone = /(?<!\d)(?:\+?1[-.\s]*)?(?:\(469\)|469)[-.\s]*863[-.\s]*9804(?!\d)/g;
const replace = text => String(text || '').replace(oldPhone, '(469) 716-9870');
async function request(endpoint, params = {}, method = 'GET') {
  const url = new URL(endpoint, base);
  if (url.origin !== 'https://graph.facebook.com') throw new Error('Unexpected API host');
  url.searchParams.delete('access_token');
  const options = { method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) };
  if (method === 'GET') for (const [k,v] of Object.entries(params)) url.searchParams.set(k,v);
  else options.body = new URLSearchParams(params);
  const res = await fetch(url, options);
  const data = await res.json();
  if (data.error) throw new Error(`Graph error ${data.error.code}/${data.error.error_subcode || 0}`);
  return data;
}
const identity = await request(page, { fields: 'id,name' });
if (identity.name !== 'Grizzly Electrical Solutions') throw new Error('Page identity mismatch');
const records = [];
let next = `${page}/${photos ? 'photos' : videos ? 'videos' : 'feed'}`;
for (let n=0; next && n<15; n++) {
  const fields = photos ? 'id,name,link,created_time,from{id}' : videos ? 'id,description,permalink_url,created_time,from{id}' : 'id,message,permalink_url,created_time,from{id}' + (collateral ? ',comments.limit(100){id,message,from{id},comments.limit(100){id,message,from{id}}}' : '');
  const data = await request(next, n ? {} : { fields, limit: '100', ...(photos ? {type:'uploaded'} : {}) });
  records.push(...(data.data || []));
  next = data.paging?.next;
}
const commentRecords = [];
let commentHasMore = false;
if (collateral) for (const post of records) {
  commentHasMore ||= Boolean(post.comments?.paging?.next);
  for (const comment of post.comments?.data || []) {
    commentRecords.push({...comment,permalink_url:post.permalink_url,kind:'comment'});
    commentHasMore ||= Boolean(comment.comments?.paging?.next);
    for (const reply of comment.comments?.data || []) commentRecords.push({...reply,permalink_url:post.permalink_url,kind:'comment'});
  }
}
const ownedComments = commentRecords.filter(c => ['108252941997164','100084297143688'].includes(c.from?.id));
const targets = collateral ? ownedComments : records;
const matches = targets.filter(p => (photos ? p.name : videos ? p.description : p.message) && replace(photos ? p.name : videos ? p.description : p.message) !== (photos ? p.name : videos ? p.description : p.message));
const audit = { at:new Date().toISOString(), page:identity.id, scanned:records.length, hasMore:Boolean(next), matches };
const inventoryName = photos ? 'facebook-photos-inventory.json' : videos ? 'facebook-videos-inventory.json' : collateral ? 'facebook-comments-inventory.json' : 'facebook-api-inventory.json';
if (collateral) Object.assign(audit,{commentsScanned:commentRecords.length,pageAuthored:ownedComments.length,commentHasMore});
fs.writeFileSync(path.join(out,inventoryName),JSON.stringify(audit,null,2));
console.log(JSON.stringify({page:identity.name,scanned:records.length,hasMore:Boolean(next),commentsScanned:collateral?commentRecords.length:undefined,pageAuthored:collateral?ownedComments.length:undefined,commentHasMore:collateral?commentHasMore:undefined,oldPhoneMatches:matches.length,apply}));
if (apply) {
  const log = path.join(out,collateral ? 'facebook-comment-edits.jsonl' : 'facebook-api-edits.jsonl');
  for (const post of matches) {
    try {
      if (post.from?.id !== identity.id && !['108252941997164','100084297143688'].includes(post.from?.id)) throw new Error('Author not confirmed as Page');
      const current = await request(post.id,{fields:'id,message'});
      const after = replace(current.message);
      if (after === current.message) continue;
      fs.appendFileSync(log,JSON.stringify({id:post.id,url:post.permalink_url,status:'backup',before:current.message,after})+'\n');
      const saved = await request(post.id,{message:after},'POST');
      if (!saved.success) throw new Error('Save unconfirmed');
      const verify = await request(post.id,{fields:'id,message'});
      if (verify.message !== after) throw new Error('Readback mismatch');
      fs.appendFileSync(log,JSON.stringify({id:post.id,url:post.permalink_url,status:'verified',at:new Date().toISOString()})+'\n');
      console.log(JSON.stringify({id:post.id,status:'verified'}));
    } catch (e) {
      fs.appendFileSync(log,JSON.stringify({id:post.id,status:'failed',error:e.message})+'\n');
      console.log(JSON.stringify({id:post.id,status:'failed',error:e.message}));
    }
  }
}
