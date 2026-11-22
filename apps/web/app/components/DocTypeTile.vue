<script setup lang="ts">
// Document type tile (ui-redesign-foundation): area colour + type icon + code.
// sm = 24 px (inline, icon only), md = 40 px (lists), lg = 52 px (preview), xl = 72 px (detail headers).
const props = withDefaults(defineProps<{ type?: string | null; size?: "sm" | "md" | "lg" | "xl" }>(), {
  type: null,
  size: "md",
});

const style = computed(() => docTypeStyle(props.type));

const box = computed(() => {
  switch (props.size) {
    case "sm":
      return { cls: "h-6 w-6 rounded-[7px]", icon: 13, stroke: 2, code: "" };
    case "lg":
      return { cls: "h-[52px] w-[52px] rounded-[13px] gap-0.5", icon: 20, stroke: 1.8, code: "text-[10px]" };
    case "xl":
      return { cls: "h-[72px] w-[72px] rounded-[18px] gap-[3px]", icon: 28, stroke: 1.7, code: "text-xs" };
    default:
      return { cls: "h-10 w-10 rounded-[10px] gap-px", icon: 16, stroke: 1.8, code: "text-[9px]" };
  }
});
</script>

<template>
  <span
    class="inline-flex flex-none flex-col items-center justify-center text-white"
    :class="box.cls"
    :style="{ backgroundColor: style.family.fill }"
    :title="`${style.name} · ${style.family.name}`"
    data-testid="doc-type-tile"
    :data-family="style.family.key"
  >
    <svg
      :width="box.icon"
      :height="box.icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      :stroke-width="box.stroke"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path :d="style.icon" />
    </svg>
    <span v-if="box.code" class="font-semibold leading-none tracking-[0.06em]" :class="box.code">{{ style.code }}</span>
  </span>
</template>
