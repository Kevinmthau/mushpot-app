"use client";

import {
  createContext,
  type CSSProperties,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { createSharedMediaResolver } from "@/lib/shared-media-resolver";

const MediaContext = createContext<
  ReturnType<typeof createSharedMediaResolver> | null
>(null);

export function SharedMediaProvider({ documentId, token, children }: {
  documentId: string;
  token: string;
  children?: ReactNode;
}) {
  const resolver = useMemo(() => createSharedMediaResolver(documentId, token), [
    documentId,
    token,
  ]);
  return (
    <MediaContext.Provider key={`${documentId}/${token}`} value={resolver}>
      {children}
    </MediaContext.Provider>
  );
}

type Props = {
  src: string;
  poster?: string;
  video: boolean;
  alt: string;
  className: string;
  style?: CSSProperties;
};

export function SharedDocumentMedia(props: Props) {
  // A changed Markdown reference needs fresh loading/error state even when React
  // retains this component at the same position during a page refresh.
  return (
    <SharedMediaElement
      key={`${props.src}\0${props.poster ?? ""}`}
      {...props}
    />
  );
}

function SharedMediaElement(props: Props) {
  const { alt, className, poster, src, style, video } = props;
  const resolver = useContext(MediaContext);
  const managed = Boolean(
    resolver?.isShared(src) || (poster && resolver?.isShared(poster)),
  );
  const imageRef = useRef<HTMLImageElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const retried = useRef(false);
  const [resolved, setResolved] = useState({
    src: resolver?.isShared(src) ? undefined : src,
    poster: poster && resolver?.isShared(poster) ? undefined : poster,
  });

  useEffect(() => {
    const element = video ? videoRef.current : imageRef.current;
    if (!managed || !resolver || !element) return;
    let cancelled = false;
    let requested = false;
    const load = () => {
      if (requested) return;
      requested = true;
      void Promise.all([
        resolver.resolve(src),
        poster ? resolver.resolve(poster) : Promise.resolve(null),
      ]).then(([media, preview]) => {
        if (!cancelled) {
          setResolved({
            src: media.url ?? undefined,
            poster: preview?.url ?? undefined,
          });
        }
      });
    };
    const observer = typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer?.disconnect();
          load();
        }
      }, { rootMargin: "600px" });
    if (observer) observer.observe(element);
    else load();
    return () => {
      cancelled = true;
      observer?.disconnect();
    };
  }, [managed, poster, resolver, src, video]);

  function retry() {
    if (!managed || retried.current) return;
    retried.current = true;
    // A URL may expire before a lazy image or video starts downloading. The
    // stable route rechecks authorization and signs a fresh URL on demand.
    setResolved({ src, poster });
  }

  const mediaStyle = managed && !resolved.src
    ? { ...style, minHeight: "3rem" }
    : style;
  const clientClassName = managed
    ? `${className} shared-media-client`
    : className;
  const fallback = video
    ? (
      <video
        aria-label={alt || "Video"}
        className={className}
        controls
        playsInline
        poster={poster}
        preload="none"
        src={src}
        style={style}
      />
    )
    : (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        alt={alt}
        className={className}
        decoding="async"
        loading="lazy"
        src={src}
        style={style}
      />
    );

  return (
    <>
      {video
        ? (
          <video
            aria-label={alt || "Video"}
            className={clientClassName}
            controls
            onError={retry}
            playsInline
            poster={resolved.poster}
            preload="none"
            ref={videoRef}
            src={resolved.src}
            style={mediaStyle}
          />
        )
        : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            alt={alt}
            className={clientClassName}
            decoding="async"
            loading="lazy"
            onError={retry}
            ref={imageRef}
            src={resolved.src}
            style={mediaStyle}
          />
        )}
      {managed && (
        <noscript>
          <style>{".shared-media-client{display:none}"}</style>
          {fallback}
        </noscript>
      )}
    </>
  );
}
