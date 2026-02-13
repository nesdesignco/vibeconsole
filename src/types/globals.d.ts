export {};

declare global {
  interface Window {
    terminalSendCommand?: (command: string, terminalId?: string | null) => void;
    terminalFocus?: () => void;
    fileTreeFocus?: () => void;
    vibe?: {
      ipc: {
        send: (channel: string, ...args: unknown[]) => void;
        invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
        on: (channel: string, listener: (...args: unknown[]) => void) => void;
      };
      clipboard: {
        readText: () => string;
        writeText: (text: string) => void;
      };
      path?: {
        join: (...parts: string[]) => string;
        dirname: (inputPath: string) => string;
        basename: (inputPath: string) => string;
        relative: (fromPath: string, toPath: string) => string;
        sep: string;
      };
    };
  }

  /**
   * The app uses plain JavaScript with runtime-selected DOM elements heavily.
   * These optional fields keep JS type-checking practical without changing runtime behavior.
   */
  interface EventTarget {
    closest?: (selector: string) => Element | null;
    classList?: DOMTokenList;
    dataset?: DOMStringMap;
  }

  interface Element {
    style?: CSSStyleDeclaration;
    title?: string;
    disabled?: boolean;
    value?: string;
    checked?: boolean;
    reset?: () => void;
    dataset?: DOMStringMap;
  }

  interface HTMLElement {
    disabled?: boolean;
    value?: string;
    checked?: boolean;
    reset?: () => void;
  }
}
