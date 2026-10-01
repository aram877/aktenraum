export default defineNuxtRouteMiddleware(async () => {
  const { $queryClient } = useNuxtApp();
  const user = await $queryClient.fetchQuery({ ...meQuery(useApi()), retry: false });
  if (!user) return navigateTo("/login");
});
