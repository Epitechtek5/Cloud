// Cloud Storage client, loaded lazily (only the snapshot functions use it).
let clientPromise;

export async function getStorage() {
  clientPromise ??= import("@google-cloud/storage")
    .then(({ Storage }) => new Storage())
    .catch((error) => {
      clientPromise = undefined;
      throw error;
    });
  return clientPromise;
}
