# Shamim IPTV Clone — Deploy করার নিয়ম

## ফাইল গঠন
```
shamim-iptv/
  index.html
  css/style.css
  js/app.js
```

## ধাপ ১ — GitHub এ আপলোড
1. GitHub এ একটা নতুন **public repository** বানাও (নাম যা খুশি, যেমন `shamim-iptv`)।
2. এই তিনটা ফাইল/ফোল্ডার (index.html, css/, js/) সেই repo তে আপলোড করো (drag & drop দিয়েও করা যায় GitHub ওয়েবসাইট থেকে)।

## ধাপ ২ — Cloudflare Pages এ Connect করা
1. https://dash.cloudflare.com এ গিয়ে একাউন্ট বানাও (ফ্রি)।
2. বাম পাশে **Workers & Pages > Create > Pages > Connect to Git**।
3. তোমার GitHub একাউন্ট connect করে `shamim-iptv` repo সিলেক্ট করো।
4. Build settings-এ কিছু বদলানোর দরকার নেই (Framework preset: **None**, Build command: খালি রাখো, Output directory: `/`)।
5. **Save and Deploy** চাপো।
6. কিছুক্ষণ পর একটা লিংক পাবে — যেমন `shamim-iptv.pages.dev`।

এরপর থেকে GitHub repo-তে যেকোনো পরিবর্তন push করলেই Cloudflare Pages নিজে থেকে re-deploy হয়ে যাবে।

## চ্যানেল প্লেলিস্ট
সাইটটা লাইভ M3U লোড করে এখান থেকে:
`https://raw.githubusercontent.com/shiptv75/SHIPTV/main/playlist.m3u`

প্লেলিস্ট আপডেট করতে হলে ওই repo-তেই পরিবর্তন করলেই চলবে — এই সাইটে কোনো কোড বদলানোর দরকার নেই।

## এখন যা যা আছে
- Splash screen + purple/magenta signature broadcast-pulse animation
- Category sidebar (Bangla, Sports, News, Movies, Music ইত্যাদি) + চ্যানেল কাউন্ট
- Search (চ্যানেল নাম/গ্রুপ দিয়ে)
- Channel grid, প্রতি ক্যাটাগরি অনুযায়ী সেকশন
- Favorites (❤ আইকনে ক্লিক — localStorage এ সেভ থাকে)
- Resume Watching ("যেখানে ছিলেন" রো)
- Player: HLS.js + mpegts.js দিয়ে স্ট্রিমিং, multi-server auto-fallback (একটা সার্ভার ফেইল করলে পরেরটা ট্রাই করে), Play/Pause, Volume, Aspect Ratio (Fit/Full/Stretch), Picture-in-Picture, Fullscreen, Share
- মোবাইল রেস্পন্সিভ (bottom sidebar drawer)

## পরে যোগ করা যাবে (এখনো নেই)
- Movies Zone (আলাদা পেজ)
- Sportz Live সেকশন (আলাদা schedule সহ)

এগুলো দরকার হলে বলো, পরের ধাপে বানিয়ে দিচ্ছি।
