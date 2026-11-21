export default defineNuxtRouteMiddleware(async () => {
  const { $queryClient } = useNuxtApp();
  try {
    const user = await $queryClient.fetchQuery({ ...meQuery(useApi()), retry: false });
    if (user) return navigateTo(user.enrolment_required ? "/enrol" : "/");
  } catch {
    return;
  }
});
