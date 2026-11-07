import type { SyncSnapshot } from "./snapshotSchema.ts";

declare global {
  interface Window {
    lyraExportAllData?: () => Promise<SyncSnapshot>;
    lyraImportDataFromObject?: (
      data: unknown,
      callback?: (progressText: string) => void,
    ) => Promise<number>;
  }
}

window.lyraExportAllData = async () => {
  const { exportSyncSnapshot } = await import("./syncSnapshot.ts");
  return exportSyncSnapshot();
};
window.lyraImportDataFromObject = async (data, callback) => {
  const { importSyncSnapshot } = await import("./syncSnapshot.ts");
  return importSyncSnapshot(data, callback);
};
