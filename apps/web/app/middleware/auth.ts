export default defineNuxtRouteMiddleware(async (to) => {
  const { $queryClient } = useNuxtApp();
  const user = await $queryClient.fetchQuery({ ...meQuery(useApi()), retry: false });
  if (!user) return navigateTo("/login");
  // A password or recovery-code session may only enrol a passkey (auth-passkeys).
  if (user.enrolment_required && to?.path !== "/enrol") return navigateTo("/enrol");
});
