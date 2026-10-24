export function newLaunchCatalogConfig() {
  return {
    productCount: 100,
    restitchEnabled: false,
    finalDurationMode: 'random-30-40' as const,
    customFinalDurationSeconds: null
  };
}
