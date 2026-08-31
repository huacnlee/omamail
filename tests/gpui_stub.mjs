// gpui's colour vocabulary is theme tokens plus hex literals. A CSS keyword it
// does not know — "transparent", most temptingly — is not a type slip the
// runtime forgives: it refuses to render the whole view. Modelling that here is
// what makes every render test a check on it, which is cheaper than finding it
// in a screenshot.
//
// A denylist rather than an allowlist, because a test's own theme double names
// its colours whatever it likes ("semantic:border"), and the mistake this is
// for is always a CSS word somebody reached for out of habit.
const REFUSED_COLORS = new Set([
  "transparent",
  "inherit",
  "initial",
  "unset",
  "currentcolor",
  "none",
  "white",
  "black",
  "red",
  "green",
  "blue",
  "gray",
  "grey",
  // A theme token gpui does not carry. Writing one is writing nothing, and it
  // reads as a colour right up until the view refuses to draw.
  "popover",
  "popover_foreground",
  "link",
  "selection",
]);

const COLOR_METHODS = new Set([
  "bg",
  "text_color",
  "border_color",
  "fill",
  "stroke",
  "shadow_color",
]);

function assertColor(method, value) {
  if (!COLOR_METHODS.has(method)) return;
  if (typeof value !== "string") return;
  const refused =
    REFUSED_COLORS.has(value.toLowerCase()) ||
    // Hyprland's own syntax, which the shell's surface sections are written in
    // and which a theme may make a *gradient* of: `rgba(6f1828e6) rgba(...)
    // 45deg`. gpui paints one colour and refuses the string, so it has to be
    // resolved before it reaches an element — see `parseHyprlandColor`.
    /[()]|\bdeg\b/.test(value);
  if (!refused) return;
  throw new TypeError(
    `unknown color token \`${value}\` passed to .${method}(); expected a theme token or a hex literal`,
  );
}

class Element {
  constructor(id = null) {
    this.elementId = id;
    this.childNodes = [];
    this.actionHandlers = new Map();
    // Every call this stub does not model is still a fact about what the view
    // asked for — a height, a colour, an SVG path. Recording them is what lets
    // a test assert the *shape* of a screen and not only its ids, which is the
    // difference between "the header exists" and "the header is 48 tall".
    this.styleCalls = [];
    const proxy = new Proxy(this, {
      get(target, property) {
        if (property in target) {
          const value = target[property];
          return typeof value === "function" ? value.bind(proxy) : value;
        }
        return (...args) => {
          assertColor(String(property), args[0]);
          target.styleCalls.push({ name: String(property), args });
          return proxy;
        };
      },
    });
    return proxy;
  }

  child(value) {
    this.childNodes.push(value);
    return this;
  }

  // A slot, not a child: the component renders it in a layer of its own. It is
  // still part of this description, so a test looking for what an open menu
  // draws has to be able to reach it.
  content(value) {
    this.childNodes.push(value);
    return this;
  }

  // The other half of the same pair: what a `Popover` hangs its surface off.
  trigger(value) {
    this.childNodes.push(value);
    return this;
  }

  id(value) {
    this.elementId = value;
    return this;
  }

  disabled(value) {
    this.isDisabled = value;
    return this;
  }

  role(value) {
    this.accessibilityRole = value;
    return this;
  }

  on_action(name, handler) {
    this.actionHandlers.set(name, handler);
    return this;
  }

  on_click(handler) {
    this.clickHandler = handler;
    return this;
  }

  on(name, handler) {
    this.actionHandlers.set(name, handler);
    return this;
  }

  children(values) {
    this.childNodes.push(...values);
    return this;
  }

  when(condition, callback) {
    return condition ? callback(this) : this;
  }
}

// Where the keyboard is, modelled rather than stubbed away: which element holds
// the focus decides which `key_context` is on the dispatch path, and that is the
// whole of what says a key means something here. A test asserting that a focused
// search field does not archive is asserting about this.
let focused = null;
export function focusHandle() {
  const handle = {
    focus() {
      focused = handle;
    },
    is_focused: () => focused === handle,
    release: () => true,
  };
  return handle;
}

export class View {}
export const div = () => new Element();
export const svg = () => new Element();
export const h_flex = () => new Element();
export const v_flex = () => new Element();
export const host_component = (name, props = {}) => {
  const element = new Element(`host-component:${name}`);
  element.hostComponent = name;
  element.props = props;
  return element;
};
export const set_theme = () => {};

const component = {
  new(id) {
    return new Element(id);
  },
};

export const Button = component;
export const Input = component;
export const NumberInput = component;
export const Tab = component;
export const Tabs = component;
// The trigger is a constructor argument, so it is a child here: it is what is
// on screen whether or not the surface above it is open.
export const Popup = {
  new(id, trigger) {
    const element = new Element(id);
    return trigger === undefined ? element : element.child(trigger);
  },
};
// `Popover` owns its trigger as a slot rather than a constructor argument, so
// both slots land as children here: a test asking what the menu draws has to
// reach the rows, and one asking what opens it has to reach the button.
// Raster artwork — the provider brand marks. `svg()` cannot draw a PNG, and
// the marks are photographs of a logotype rather than glyphs, so they come
// through here.
export function image(path) {
  return new Element(`image:${path}`);
}

export const Popover = component;
export const Textarea = component;
export const TextView = {
  html(id, text) {
    const element = new Element(id);
    element.html = text;
    return element;
  },
  markdown(id, text) {
    const element = new Element(id);
    element.markdown = text;
    return element;
  },
};
export const Link = component;

// The rest of `gpui-base`'s catalog, present because `omarchy-ui` is imported
// through its own barrel: ESM instantiates every module the entry re-exports,
// so a name this application never draws still has to exist for the ones it
// does. They are the plain recording element the other components are — the
// library's own tests cover what each of them is given.
export const Avatar = component;
export const AvatarFallback = component;
export const TableHeader = component;
export const TableHead = component;
export const TableRow = component;
export const TableCell = component;
export const Accordion = component;
export const AccordionItem = component;
export const AccordionHeader = component;
export const AccordionTrigger = component;
export const AccordionPanel = component;
function textState(options = {}) {
  let value = String(options.value ?? "");
  let masked = options.masked === true;
  const handlers = new Map();
  return {
    options,
    value: () => value,
    set_value(next) {
      value = String(next);
    },
    // Real state, not a no-op: whether a credential field is showing its
    // contents is a fact a test should be able to assert.
    is_masked: () => masked,
    set_masked(next) {
      masked = next === true;
    },
    on(event, handler) {
      handlers.set(event, handler);
      return true;
    },
    emit(event, cx = {}) {
      handlers.get(event)?.({}, cx);
    },
  };
}
export const InputState = {
  new(options = {}) {
    return textState(options);
  },
};
export const TextareaState = {
  new(options = {}) {
    return textState(options);
  },
};
