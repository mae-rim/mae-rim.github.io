#!/usr/bin/env node
/**
 * Google のクチコミを取得して reviews.json を生成する。
 * 1日1回、GitHub Actions や cron から実行する想定。
 * ブラウザから直接 API を叩かないので、APIキーが公開されない・閲覧数に比例して課金されない。
 *
 * 2つのモード:
 *   MODE=gbp    … Google ビジネスプロフィール API（自店舗のオーナー権限が必要）
 *                 ・本当の新着順（orderBy=updateTime desc）
 *                 ・全件取得できる（50件/ページ）
 *                 ・オーナー返信も取れる  ← 低評価対策の本命
 *   MODE=places … Places API (New)（誰でも使える）
 *                 ・関連度順の最大5件しか返らない。新着順の指定は不可。
 *                 ・取得した5件を投稿日で並べ替えているだけ、という点は理解しておくこと。
 *
 * 使い方:
 *   MODE=gbp node scripts/fetch-reviews.mjs
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/* ------------------------------------------------------------------ *
 * 掲載基準（ここが法務上いちばん大事な部分）
 * ------------------------------------------------------------------ */

/**
 * 星の数による除外は「意図的に実装していない」。
 * 自社に都合のよい高評価だけを選んで並べ、全体の評価を実際より良く見せる行為は
 * 景品表示法の優良誤認にあたるおそれがある。
 * 低評価を見せたくない場合は、除外ではなく
 *   ・総合評価と総件数を正直に併記する（このスクリプトは必ず出力する）
 *   ・オーナー返信をセットで表示する
 *   ・表示件数を絞り、新着順という客観ルールを明示する
 * で対処すること。詳しくは README-reviews.md を参照。
 */

/** 本文がこの文字数未満の投稿は掲載しない（引用に足る内容がないため） */
const MIN_CHARS = 15;

/**
 * 薬機法・景品表示法まわりで、掲載すると店側の効能効果の訴求とみなされうる表現。
 * リラクゼーションサロンは医業類似行為ではないので、体験談であっても
 * 「治った」「改善した」を自社サイトに載せると店の広告表現として扱われる。
 * 高評価の投稿ほど引っかかりやすい＝高評価を優遇する仕組みではない点に注意。
 */
const NG_PATTERNS = [
  /治(っ|り|る|療|癒)/, /完治/, /快方/,
  /改善/, /解消/, /矯正/, /整体/, /診断/, /処方/,
  /腰痛|肩こりが消|ヘルニア|坐骨神経痛|自律神経|更年期|不眠症|うつ病|外反母趾/,
  /痩せ|ダイエット|むくみが取れ|デトックス|代謝が上が|免疫力|血行が良く/,
  /病院|医者|医師|薬/,
];

/** 表示に回す最大件数（多めに出しておき、表示側で絞る） */
const MAX_OUT = 12;

/* ------------------------------------------------------------------ */

const OUT = process.env.OUT ?? 'reviews.json';
const MODE = process.env.MODE ?? 'places';

const die = (msg) => { console.error('ERROR: ' + msg); process.exit(1); };
const need = (k) => process.env[k] || die(`環境変数 ${k} が未設定です`);

/** 掲載基準にかけ、残したものと除外理由の内訳を返す */
function applyPolicy(reviews) {
  const skipped = { noText: 0, tooShort: 0, expression: 0 };
  const kept = [];
  for (const r of reviews) {
    const text = (r.text ?? '').trim();
    if (!text) { skipped.noText++; continue; }
    if (text.length < MIN_CHARS) { skipped.tooShort++; continue; }
    if (NG_PATTERNS.some((re) => re.test(text))) { skipped.expression++; continue; }
    kept.push({ ...r, text });
  }
  return { kept, skipped };
}

const byNewest = (a, b) => Date.parse(b.time) - Date.parse(a.time);

/* ---------------------------- Places API (New) ---------------------------- */

async function fromPlaces() {
  const key = need('GOOGLE_MAPS_API_KEY');
  const placeId = need('PLACE_ID');

  const fields = [
    'id', 'displayName', 'rating', 'userRatingCount', 'googleMapsUri',
    'reviews.name', 'reviews.rating', 'reviews.text', 'reviews.originalText',
    'reviews.publishTime', // 👈 relativePublishTime を削除しました
    'reviews.authorAttribution', 'reviews.flagContentUri', 'reviews.googleMapsUri',
  ].join(',');

  const res = await fetch(
    `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?languageCode=ja&regionCode=JP`,
    { headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': fields } },
  );
  if (!res.ok) die(`Places API ${res.status}: ${await res.text()}`);
  const p = await res.json();

  const reviews = (p.reviews ?? []).map((r) => ({
    id: r.name,
    rating: r.rating,
    // originalText を優先。Google の自動翻訳版ではなく投稿されたままの文面を載せる
    text: r.originalText?.text ?? r.text?.text ?? '',
    time: r.publishTime,
    relativeTime: r.relativePublishTime ?? null,
    author: r.authorAttribution?.displayName ?? null,
    reply: null,                       // Places API はオーナー返信を返さない
    flagUri: r.flagContentUri ?? null, // 不適切コンテンツ報告リンク（表示が必須）
  })).sort(byNewest);

  return {
    place: {
      name: p.displayName?.text ?? null,
      rating: p.rating ?? null,
      userRatingCount: p.userRatingCount ?? 0,
      googleMapsUri: p.googleMapsUri ?? null,
      reviewUri: p.googleMapsUri ? `${p.googleMapsUri}&hl=ja` : null,
    },
    reviews,
    sortNote: 'Places API は関連度順の最大5件しか返さないため、その5件を投稿日順に並べたもの',
  };
}

/* ------------------------ Google ビジネスプロフィール API ------------------------ */

async function gbpAccessToken() {
  const body = new URLSearchParams({
    client_id: need('GBP_CLIENT_ID'),
    client_secret: need('GBP_CLIENT_SECRET'),
    refresh_token: need('GBP_REFRESH_TOKEN'),
    grant_type: 'refresh_token',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) die(`OAuth ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

const STAR = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

async function fromGbp() {
  const account = need('GBP_ACCOUNT_ID');   // 例: 1234567890
  const location = need('GBP_LOCATION_ID'); // 例: 0987654321
  const token = await gbpAccessToken();

  const url = new URL(
    `https://mybusiness.googleapis.com/v4/accounts/${account}/locations/${location}/reviews`,
  );
  url.searchParams.set('pageSize', '50');
  url.searchParams.set('orderBy', 'updateTime desc'); // 本物の新着順

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) die(`Business Profile API ${res.status}: ${await res.text()}`);
  const data = await res.json();

  const reviews = (data.reviews ?? []).map((r) => ({
    id: r.reviewId ?? r.name,
    rating: STAR[r.starRating] ?? null,
    text: r.comment ?? '',
    time: r.createTime,
    relativeTime: null,
    author: r.reviewer?.displayName ?? null,
    reply: r.reviewReply ? { text: r.reviewReply.comment, time: r.reviewReply.updateTime } : null,
    flagUri: null,
  })).sort(byNewest);

  const placeId = process.env.PLACE_ID ?? null;
  return {
    place: {
      name: process.env.PLACE_NAME ?? null,
      rating: data.averageRating ?? null,
      userRatingCount: data.totalReviewCount ?? 0,
      googleMapsUri: placeId ? `https://www.google.com/maps/place/?q=place_id:${placeId}` : null,
      reviewUri: placeId ? `https://search.google.com/local/reviews?placeid=${placeId}` : null,
    },
    reviews,
    sortNote: '投稿日の新しい順（全件から）',
  };
}

/* --------------------------------- main --------------------------------- */

const raw = MODE === 'gbp' ? await fromGbp() : await fromPlaces();
const { kept, skipped } = applyPolicy(raw.reviews);

// 前回の出力を残しておき、API が落ちた日に空にならないようにする
let previous = null;
try { previous = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* 初回 */ }

if (!kept.length && previous?.reviews?.length) {
  console.warn('今回は掲載できる投稿が0件だったため、前回の内容を維持します');
  process.exit(0);
}

const now = new Date();
const out = {
  generatedAt: now.toISOString(),
  // Places API 由来のコンテンツは30日を超えてキャッシュしない（Google Maps Platform 利用規約）
  expiresAt: new Date(now.getTime() + 30 * 86400000).toISOString(),
  source: MODE,
  place: raw.place,
  policy: {
    sort: raw.sortNote,
    ratingFilter: 'なし（星の数による選別はしていない）',
    minChars: MIN_CHARS,
    skipped,
  },
  reviews: kept.slice(0, MAX_OUT),
};

await mkdir(dirname(OUT) === '.' ? '.' : dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(out, null, 2) + '\n', 'utf8');

console.log(
  `${OUT} を更新: 掲載 ${out.reviews.length}件 / 取得 ${raw.reviews.length}件 ` +
  `（除外 本文なし${skipped.noText} 短すぎ${skipped.tooShort} 表現${skipped.expression}）` +
  ` 平均 ${raw.place.rating} / 全${raw.place.userRatingCount}件`,
);
