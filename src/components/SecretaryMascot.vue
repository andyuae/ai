<script setup lang="ts">
/**
 * 小秘书头像：软糯的短发女孩（大眼 + 腮红 + 白衬衫 / 深蓝小西装 / 金领带）。
 * 纯 SVG，缩到 26px 仍能看清表情；size 控制像素边长。
 */
withDefaults(defineProps<{ size?: number }>(), { size: 46 })

/* 渐变 / 滤镜 / 裁剪的 id 必须唯一，否则同页多个实例会互相覆盖 */
const uid = `sm${Math.random().toString(36).slice(2, 8)}`
const id = (n: string) => `${n}-${uid}`
</script>

<template>
  <svg class="mascot" :width="size" :height="size" viewBox="0 0 48 48"
    role="img" aria-label="小秘书">
    <defs>
      <linearGradient :id="id('bg')" x1="4" y1="1" x2="40" y2="46" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#ffffff" />
        <stop offset="1" stop-color="#e2ebfd" />
      </linearGradient>
      <radialGradient :id="id('skin')" cx="36%" cy="26%" r="82%">
        <stop offset="0" stop-color="#fff4ea" />
        <stop offset="58%" stop-color="#ffe2cd" />
        <stop offset="100%" stop-color="#f7cbae" />
      </radialGradient>
      <linearGradient :id="id('neck')" x1="24" y1="29" x2="24" y2="40" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#f6c9a9" />
        <stop offset="100%" stop-color="#ffdcc2" />
      </linearGradient>
      <linearGradient :id="id('hair')" x1="10" y1="7" x2="38" y2="34" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#6a5767" />
        <stop offset="42%" stop-color="#3e3140" />
        <stop offset="100%" stop-color="#241c26" />
      </linearGradient>
      <linearGradient :id="id('shirt')" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffffff" />
        <stop offset="100%" stop-color="#e6edfa" />
      </linearGradient>
      <linearGradient :id="id('suit')" x1="24" y1="37" x2="24" y2="48" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#41669e" />
        <stop offset="100%" stop-color="#1b3355" />
      </linearGradient>
      <radialGradient :id="id('eye')" cx="40%" cy="28%" r="82%">
        <stop offset="0" stop-color="#4d3b46" />
        <stop offset="100%" stop-color="#211a23" />
      </radialGradient>
      <filter :id="id('soft')" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="1" />
      </filter>
      <clipPath :id="id('avatar')">
        <circle cx="24" cy="24" r="23.2" />
      </clipPath>
      <clipPath :id="id('bangs')">
        <path d="M0 0H48V18.9C44.2 20.7 40.2 20.5 36.4 18.9C31.6 16.8 28.6 15.7 24 15.9C19.6 16.1 16.4 17.5 11.8 19.3C8 20.7 3.8 20.3 0 18.4Z" />
      </clipPath>
    </defs>

    <circle cx="24" cy="24" r="23.2" :fill="`url(#${id('bg')})`" />

    <g :clip-path="`url(#${id('avatar')})`">
    <g transform="translate(24 23) scale(1.18) translate(-24 -23)">
    <!-- 脖子 -->
    <rect x="21.8" y="30.2" width="4.4" height="8" rx="2.2" :fill="`url(#${id('neck')})`" />
    <!-- 深蓝西装 + 白衬衫 + 金领带 -->
    <path d="M11 48c0-7.4 5.4-11.2 13-11.2S37 40.6 37 48Z" :fill="`url(#${id('suit')})`" />
    <path d="M18.4 37 24 43.8l5.6-6.8-2.2-1.1L24 39.4l-3.4-3.5z" :fill="`url(#${id('shirt')})`" />
    <path d="M22.7 36.8h2.6l.9 1.7-2.2 2.5-2.2-2.5z" fill="#e0b160" />

    <!-- 头发：后层轮廓 + 两侧发梢 -->
    <circle cx="24" cy="19.2" r="12.6" :fill="`url(#${id('hair')})`" />
    <path d="M12.2 17.4c-1.7 4.4-1.4 8.9.9 12.6 2 .5 3.3-.7 3.4-2.7-.8-3.4-.5-7 .9-10.5z" :fill="`url(#${id('hair')})`" />
    <path d="M35.8 17.4c1.7 4.4 1.4 8.9-.9 12.6-2 .5-3.3-.7-3.4-2.7.8-3.4.5-7-.9-10.5z" :fill="`url(#${id('hair')})`" />

    <!-- 脸 -->
    <ellipse cx="24" cy="22.8" rx="10.4" ry="10" :fill="`url(#${id('skin')})`" />

    <!-- 刘海：用同一个头发渐变的圆裁出来，边缘自然 -->
    <g :clip-path="`url(#${id('bangs')})`">
      <circle cx="24" cy="19.2" r="12.6" :fill="`url(#${id('hair')})`" />
    </g>
    <!-- 额前极淡的阴影，让刘海看起来有厚度 -->
    <ellipse cx="24" cy="17.8" rx="10.4" ry="2.6" fill="#2a1f27" opacity=".05" :filter="`url(#${id('soft')})`" />

    <!-- 眼睛（大眼 + 高光） -->
    <ellipse cx="19.4" cy="23.6" rx="1.9" ry="2.6" :fill="`url(#${id('eye')})`" />
    <ellipse cx="28.6" cy="23.6" rx="1.9" ry="2.6" :fill="`url(#${id('eye')})`" />
    <circle cx="18.7" cy="22.6" r=".76" fill="#fff" />
    <circle cx="27.9" cy="22.6" r=".76" fill="#fff" />
    <circle cx="20.2" cy="25" r=".35" fill="#fff" opacity=".75" />
    <circle cx="29.4" cy="25" r=".35" fill="#fff" opacity=".75" />

    <!-- 腮红 -->
    <g :filter="`url(#${id('soft')})`">
      <ellipse cx="16.6" cy="26.8" rx="2.1" ry="1.2" fill="#ff9b8c" opacity=".42" />
      <ellipse cx="31.4" cy="26.8" rx="2.1" ry="1.2" fill="#ff9b8c" opacity=".42" />
    </g>

    <!-- 微笑 -->
    <path d="M22.5 27.9q1.5 1.5 3 0" fill="none" stroke="#c67a63" stroke-width=".95" stroke-linecap="round" />
    </g>
    </g>

    <circle cx="24" cy="24" r="23.2" fill="none" stroke="rgba(22,56,107,.08)" stroke-width="1.2" />
  </svg>
</template>

<style scoped>
.mascot { display: block; }
</style>
