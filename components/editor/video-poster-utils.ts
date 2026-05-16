const POSTER_MAX_DIMENSION = 1280;
const POSTER_GENERATION_TIMEOUT_MS = 15_000;
const POSTER_JPEG_QUALITY = 0.8;

function getPosterFileName(videoFileName: string) {
  const withoutExtension = videoFileName.replace(/\.[^/.]+$/, "").trim();
  const baseName = withoutExtension || "video";
  return `${baseName}-poster.jpg`;
}

function getPosterCanvasSize(width: number, height: number) {
  const longestSide = Math.max(width, height);
  if (longestSide <= POSTER_MAX_DIMENSION) {
    return { width, height };
  }

  const scale = POSTER_MAX_DIMENSION / longestSide;
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  };
}

export async function generateVideoPosterImage(file: File): Promise<File | null> {
  if (typeof document === "undefined") {
    return null;
  }

  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement("video");

  return new Promise<File | null>((resolve) => {
    let settled = false;

    const finish = (result: File | null) => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timeoutId);
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(objectUrl);
      resolve(result);
    };

    const timeoutId = window.setTimeout(() => finish(null), POSTER_GENERATION_TIMEOUT_MS);

    video.addEventListener("error", () => finish(null));

    video.addEventListener("loadedmetadata", () => {
      const seekTime = Number.isFinite(video.duration)
        ? Math.min(0.1, video.duration)
        : 0.1;
      try {
        video.currentTime = seekTime;
      } catch {
        finish(null);
      }
    });

    video.addEventListener("seeked", () => {
      try {
        if (!video.videoWidth || !video.videoHeight) {
          finish(null);
          return;
        }

        const { width, height } = getPosterCanvasSize(
          video.videoWidth,
          video.videoHeight,
        );
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;

        const context = canvas.getContext("2d");
        if (!context) {
          finish(null);
          return;
        }

        context.drawImage(video, 0, 0, width, height);
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              finish(null);
              return;
            }

            finish(
              new File([blob], getPosterFileName(file.name), {
                type: "image/jpeg",
              }),
            );
          },
          "image/jpeg",
          POSTER_JPEG_QUALITY,
        );
      } catch {
        finish(null);
      }
    });

    video.muted = true;
    video.preload = "auto";
    video.src = objectUrl;
  });
}
