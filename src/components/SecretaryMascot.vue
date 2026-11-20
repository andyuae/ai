<script setup lang="ts">
/**
 * 小秘书公仔：一只戴眼镜、戴耳麦、系领带的商务小熊。
 * 纯 SVG，缩到 26px 仍能看清表情；size 控制像素边长。
 */
withDefaults(defineProps<{ size?: number }>(), { size: 46 })

/* 渐变 id 必须唯一，否则同页多个实例会互相覆盖 */
const uid = `sm${Math.random().toString(36).slice(2, 8)}`
</script>

<template>
  <svg class="mascot" :width="size" :height="size" viewBox="0 0 48 48"
    role="img" aria-label="小秘书">
    <defs>
      <linearGradient :id="`${uid}-bg`" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#f8fbff" />
        <stop offset="1" stop-color="#dae6ff" />
      </linearGradient>
      <linearGradient :id="`${uid}-suit`" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#2b5187" />
        <stop offset="1" stop-color="#17335a" />
      </linearGradient>
      <clipPath :id="`${uid}-clip`">
        <circle cx="24" cy="24" r="23.2" />
      </clipPath>
    </defs>

    <circle cx="24" cy="24" r="23.2" :fill="`url(#${uid}-bg)`" />

    <g :clip-path="`url(#${uid}-clip)`">
      <!-- 西装肩膀 -->
      <path d="M10.5 48c0-7.4 5-11.6 13.5-11.6S37.5 40.6 37.5 48Z" :fill="`url(#${uid}-suit)`" />
      <!-- 衬衫领口 + 金色领带 -->
      <path d="M20.2 36.2 24 42.4l3.8-6.2-2-1-1.8 2.2-1.8-2.2z" fill="#f5f9ff" />
      <path d="M23.7 36.1h1.6l.5 1.8-1.3 3.8-1.3-3.8z" fill="#e0b160" />
      <!-- 脖子 -->
      <rect x="21.3" y="28.4" width="5.4" height="9" rx="2.7" fill="#c99a6c" />

      <!-- 耳朵 -->
      <circle cx="13.4" cy="12.6" r="4.6" fill="#a9784f" />
      <circle cx="34.6" cy="12.6" r="4.6" fill="#a9784f" />
      <circle cx="13.4" cy="12.6" r="2.4" fill="#d9a97e" />
      <circle cx="34.6" cy="12.6" r="2.4" fill="#d9a97e" />

      <!-- 头 + 口鼻 -->
      <circle cx="24" cy="21.6" r="12.2" fill="#b98a5e" />
      <ellipse cx="24" cy="26.4" rx="6.6" ry="5.6" fill="#f0d8bd" />

      <!-- 腮红 -->
      <ellipse cx="18" cy="24.8" rx="1.7" ry="1" fill="#e0805f" opacity=".38" />
      <ellipse cx="30" cy="24.8" rx="1.7" ry="1" fill="#e0805f" opacity=".38" />

      <!-- 眼镜 -->
      <rect x="16.4" y="19.6" width="6.4" height="5.2" rx="2.4" fill="#fff" opacity=".5" stroke="#5b4632" stroke-width="1.2" />
      <rect x="25.2" y="19.6" width="6.4" height="5.2" rx="2.4" fill="#fff" opacity=".5" stroke="#5b4632" stroke-width="1.2" />
      <path d="M22.8 21.8h2.4" stroke="#5b4632" stroke-width="1.2" />

      <!-- 眼睛 -->
      <ellipse cx="19.6" cy="22.2" rx="1.4" ry="1.6" fill="#2b3444" />
      <ellipse cx="28.4" cy="22.2" rx="1.4" ry="1.6" fill="#2b3444" />
      <circle cx="19.1" cy="21.5" r=".45" fill="#fff" />
      <circle cx="27.9" cy="21.5" r=".45" fill="#fff" />

      <!-- 鼻子与嘴 -->
      <ellipse cx="24" cy="25.4" rx="1.5" ry="1.1" fill="#3a2a20" />
      <path d="M24 26.5v1.1M22.4 28.1q1.6 1.5 3.2 0" fill="none" stroke="#7a5334" stroke-width=".9" stroke-linecap="round" />

      <!-- 耳麦 -->
      <path d="M11.4 21.2a12.7 12.7 0 0 1 25.2 0" fill="none" stroke="#3f7bff" stroke-width="1.9" />
      <rect x="9.8" y="18.6" width="3.6" height="6.6" rx="1.8" fill="#3f7bff" />
      <rect x="34.6" y="18.6" width="3.6" height="6.6" rx="1.8" fill="#3f7bff" />
      <path d="M11.6 25.4q.3 4.2 4.4 4.8" fill="none" stroke="#3f7bff" stroke-width="1.5" stroke-linecap="round" />
      <circle cx="16.5" cy="30.4" r="1.5" fill="#3f7bff" />
    </g>

    <circle cx="24" cy="24" r="23.2" fill="none" stroke="rgba(22,56,107,.10)" stroke-width="1.2" />
  </svg>
</template>

<style scoped>
.mascot { display: block; }
</style>
