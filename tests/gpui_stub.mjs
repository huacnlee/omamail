class Element {
  constructor(id = null) {
    this.elementId = id;
    this.childNodes = [];
    this.actionHandlers = new Map();
    const proxy = new Proxy(this, {
      get(target, property) {
        if (property in target) {
          const value = target[property];
          return typeof value === "function" ? value.bind(proxy) : value;
        }
        return (..._arguments) => proxy;
      },
    });
    return proxy;
  }

  child(value) {
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

  children(values) {
    this.childNodes.push(...values);
    return this;
  }

  when(condition, callback) {
    return condition ? callback(this) : this;
  }
}

export class View {}
export const div = () => new Element();
export const svg = () => new Element();
export const h_flex = () => new Element();
export const v_flex = () => new Element();
export const set_theme = () => {};

const component = {
  new(id) {
    return new Element(id);
  },
};

export const Button = component;
export const Input = component;
export const Textarea = component;
export const Link = component;
function textState(options = {}) {
  let value = String(options.value ?? "");
  const handlers = new Map();
  return {
    options,
    value: () => value,
    set_value(next) {
      value = String(next);
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
