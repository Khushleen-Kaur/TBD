declare module 'aladin-lite' {
  export interface AladinOverlay {
    add: (shape: unknown) => void;
    removeAll?: () => void;
  }

  export interface AladinCatalogLayer {
    show?: () => void;
    hide?: () => void;
  }

  export interface AladinInstance {
    gotoRaDec: (ra: number, dec: number) => void;
    gotoObject?: (
      name: string,
      callbacks?: { success?: (raDec: [number, number]) => void; error?: () => void }
    ) => void;
    setFoV: (fov: number) => void;
    getFoV?: () => [number, number] | number;
    getRaDec?: () => [number, number];
    showCooGrid?: () => void;
    hideCooGrid?: () => void;
    addOverlay: (overlay: AladinOverlay) => void;
    addCatalog?: (catalog: AladinCatalogLayer) => void;
    displayFITS?: (
      url: string,
      options?: Record<string, unknown>,
      successCallback?: () => void,
      errorCallback?: () => void,
      layer?: string
    ) => void;
    removeImageLayer?: (layer: string) => void;
    setBaseImageLayer?: (survey: string) => void;
    on?: (eventName: string, handler: (...args: unknown[]) => void) => void;
    view?: {
      redrawClbk?: () => void;
    };
  }

  export interface AladinNamespace {
    init: Promise<void>;
    aladin: (selector: string | HTMLElement, options: Record<string, unknown>) => AladinInstance;
    graphicOverlay: (options?: Record<string, unknown>) => AladinOverlay;
    polygon: (coords: number[][], options?: Record<string, unknown>) => unknown;
    circle?: (ra: number, dec: number, radiusDeg: number, options?: Record<string, unknown>) => unknown;
    catalogHiPS?: (url: string, options?: Record<string, unknown>) => AladinCatalogLayer;
  }

  const A: AladinNamespace;
  export default A;
}
