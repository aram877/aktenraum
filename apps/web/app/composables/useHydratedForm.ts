import type { Ref } from "vue";

export function useHydratedForm(detail: Ref<InboxDetail | undefined>, onNewDocument?: () => void) {
  const form = ref<FormState>({ ...EMPTY_FORM });
  let lastHydrated: FormState | null = null;
  let lastHydratedId: number | null = null;

  watch(
    detail,
    (data) => {
      if (!data) return;
      const next = detailToForm(data);
      if (lastHydratedId !== data.id) {
        form.value = next;
        lastHydrated = next;
        lastHydratedId = data.id;
        onNewDocument?.();
        return;
      }
      form.value = mergeHydration(form.value, lastHydrated, next);
      lastHydrated = next;
    },
    { immediate: true },
  );

  const patch = computed<InboxFieldUpdate>(() =>
    detail.value ? buildDirtyPatch(form.value, detail.value) : {},
  );
  const dirty = computed(() => Object.keys(patch.value).length > 0);

  function reset(): void {
    if (detail.value) form.value = detailToForm(detail.value);
  }

  return { form, patch, dirty, reset };
}
