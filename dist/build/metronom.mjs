var Metronom = (function () {
    'use strict';

    function noop() { }
    function run(fn) {
        return fn();
    }
    function blank_object() {
        return Object.create(null);
    }
    function run_all(fns) {
        fns.forEach(run);
    }
    function is_function(thing) {
        return typeof thing === 'function';
    }
    function safe_not_equal(a, b) {
        return a != a ? b == b : a !== b || ((a && typeof a === 'object') || typeof a === 'function');
    }
    function is_empty(obj) {
        return Object.keys(obj).length === 0;
    }
    function append(target, node) {
        target.appendChild(node);
    }
    function insert(target, node, anchor) {
        target.insertBefore(node, anchor || null);
    }
    function detach(node) {
        node.parentNode.removeChild(node);
    }
    function element(name) {
        return document.createElement(name);
    }
    function text(data) {
        return document.createTextNode(data);
    }
    function space() {
        return text(' ');
    }
    function listen(node, event, handler, options) {
        node.addEventListener(event, handler, options);
        return () => node.removeEventListener(event, handler, options);
    }
    function attr(node, attribute, value) {
        if (value == null)
            node.removeAttribute(attribute);
        else if (node.getAttribute(attribute) !== value)
            node.setAttribute(attribute, value);
    }
    function to_number(value) {
        return value === '' ? null : +value;
    }
    function children(element) {
        return Array.from(element.childNodes);
    }
    function set_data(text, data) {
        data = '' + data;
        if (text.wholeText !== data)
            text.data = data;
    }
    function set_input_value(input, value) {
        input.value = value == null ? '' : value;
    }
    function attribute_to_object(attributes) {
        const result = {};
        for (const attribute of attributes) {
            result[attribute.name] = attribute.value;
        }
        return result;
    }

    let current_component;
    function set_current_component(component) {
        current_component = component;
    }

    const dirty_components = [];
    const binding_callbacks = [];
    const render_callbacks = [];
    const flush_callbacks = [];
    const resolved_promise = Promise.resolve();
    let update_scheduled = false;
    function schedule_update() {
        if (!update_scheduled) {
            update_scheduled = true;
            resolved_promise.then(flush);
        }
    }
    function add_render_callback(fn) {
        render_callbacks.push(fn);
    }
    // flush() calls callbacks in this order:
    // 1. All beforeUpdate callbacks, in order: parents before children
    // 2. All bind:this callbacks, in reverse order: children before parents.
    // 3. All afterUpdate callbacks, in order: parents before children. EXCEPT
    //    for afterUpdates called during the initial onMount, which are called in
    //    reverse order: children before parents.
    // Since callbacks might update component values, which could trigger another
    // call to flush(), the following steps guard against this:
    // 1. During beforeUpdate, any updated components will be added to the
    //    dirty_components array and will cause a reentrant call to flush(). Because
    //    the flush index is kept outside the function, the reentrant call will pick
    //    up where the earlier call left off and go through all dirty components. The
    //    current_component value is saved and restored so that the reentrant call will
    //    not interfere with the "parent" flush() call.
    // 2. bind:this callbacks cannot trigger new flush() calls.
    // 3. During afterUpdate, any updated components will NOT have their afterUpdate
    //    callback called a second time; the seen_callbacks set, outside the flush()
    //    function, guarantees this behavior.
    const seen_callbacks = new Set();
    let flushidx = 0; // Do *not* move this inside the flush() function
    function flush() {
        const saved_component = current_component;
        do {
            // first, call beforeUpdate functions
            // and update components
            while (flushidx < dirty_components.length) {
                const component = dirty_components[flushidx];
                flushidx++;
                set_current_component(component);
                update(component.$$);
            }
            set_current_component(null);
            dirty_components.length = 0;
            flushidx = 0;
            while (binding_callbacks.length)
                binding_callbacks.pop()();
            // then, once components are updated, call
            // afterUpdate functions. This may cause
            // subsequent updates...
            for (let i = 0; i < render_callbacks.length; i += 1) {
                const callback = render_callbacks[i];
                if (!seen_callbacks.has(callback)) {
                    // ...so guard against infinite loops
                    seen_callbacks.add(callback);
                    callback();
                }
            }
            render_callbacks.length = 0;
        } while (dirty_components.length);
        while (flush_callbacks.length) {
            flush_callbacks.pop()();
        }
        update_scheduled = false;
        seen_callbacks.clear();
        set_current_component(saved_component);
    }
    function update($$) {
        if ($$.fragment !== null) {
            $$.update();
            run_all($$.before_update);
            const dirty = $$.dirty;
            $$.dirty = [-1];
            $$.fragment && $$.fragment.p($$.ctx, dirty);
            $$.after_update.forEach(add_render_callback);
        }
    }
    const outroing = new Set();
    function transition_in(block, local) {
        if (block && block.i) {
            outroing.delete(block);
            block.i(local);
        }
    }
    function mount_component(component, target, anchor, customElement) {
        const { fragment, on_mount, on_destroy, after_update } = component.$$;
        fragment && fragment.m(target, anchor);
        if (!customElement) {
            // onMount happens before the initial afterUpdate
            add_render_callback(() => {
                const new_on_destroy = on_mount.map(run).filter(is_function);
                if (on_destroy) {
                    on_destroy.push(...new_on_destroy);
                }
                else {
                    // Edge case - component was destroyed immediately,
                    // most likely as a result of a binding initialising
                    run_all(new_on_destroy);
                }
                component.$$.on_mount = [];
            });
        }
        after_update.forEach(add_render_callback);
    }
    function destroy_component(component, detaching) {
        const $$ = component.$$;
        if ($$.fragment !== null) {
            run_all($$.on_destroy);
            $$.fragment && $$.fragment.d(detaching);
            // TODO null out other refs, including component.$$ (but need to
            // preserve final state?)
            $$.on_destroy = $$.fragment = null;
            $$.ctx = [];
        }
    }
    function make_dirty(component, i) {
        if (component.$$.dirty[0] === -1) {
            dirty_components.push(component);
            schedule_update();
            component.$$.dirty.fill(0);
        }
        component.$$.dirty[(i / 31) | 0] |= (1 << (i % 31));
    }
    function init(component, options, instance, create_fragment, not_equal, props, append_styles, dirty = [-1]) {
        const parent_component = current_component;
        set_current_component(component);
        const $$ = component.$$ = {
            fragment: null,
            ctx: null,
            // state
            props,
            update: noop,
            not_equal,
            bound: blank_object(),
            // lifecycle
            on_mount: [],
            on_destroy: [],
            on_disconnect: [],
            before_update: [],
            after_update: [],
            context: new Map(options.context || (parent_component ? parent_component.$$.context : [])),
            // everything else
            callbacks: blank_object(),
            dirty,
            skip_bound: false,
            root: options.target || parent_component.$$.root
        };
        append_styles && append_styles($$.root);
        let ready = false;
        $$.ctx = instance
            ? instance(component, options.props || {}, (i, ret, ...rest) => {
                const value = rest.length ? rest[0] : ret;
                if ($$.ctx && not_equal($$.ctx[i], $$.ctx[i] = value)) {
                    if (!$$.skip_bound && $$.bound[i])
                        $$.bound[i](value);
                    if (ready)
                        make_dirty(component, i);
                }
                return ret;
            })
            : [];
        $$.update();
        ready = true;
        run_all($$.before_update);
        // `false` as a special case of no DOM component
        $$.fragment = create_fragment ? create_fragment($$.ctx) : false;
        if (options.target) {
            if (options.hydrate) {
                const nodes = children(options.target);
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                $$.fragment && $$.fragment.l(nodes);
                nodes.forEach(detach);
            }
            else {
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                $$.fragment && $$.fragment.c();
            }
            if (options.intro)
                transition_in(component.$$.fragment);
            mount_component(component, options.target, options.anchor, options.customElement);
            flush();
        }
        set_current_component(parent_component);
    }
    let SvelteElement;
    if (typeof HTMLElement === 'function') {
        SvelteElement = class extends HTMLElement {
            constructor() {
                super();
                this.attachShadow({ mode: 'open' });
            }
            connectedCallback() {
                const { on_mount } = this.$$;
                this.$$.on_disconnect = on_mount.map(run).filter(is_function);
                // @ts-ignore todo: improve typings
                for (const key in this.$$.slotted) {
                    // @ts-ignore todo: improve typings
                    this.appendChild(this.$$.slotted[key]);
                }
            }
            attributeChangedCallback(attr, _oldValue, newValue) {
                this[attr] = newValue;
            }
            disconnectedCallback() {
                run_all(this.$$.on_disconnect);
            }
            $destroy() {
                destroy_component(this, 1);
                this.$destroy = noop;
            }
            $on(type, callback) {
                // TODO should this delegate to addEventListener?
                const callbacks = (this.$$.callbacks[type] || (this.$$.callbacks[type] = []));
                callbacks.push(callback);
                return () => {
                    const index = callbacks.indexOf(callback);
                    if (index !== -1)
                        callbacks.splice(index, 1);
                };
            }
            $set($$props) {
                if (this.$$set && !is_empty($$props)) {
                    this.$$.skip_bound = true;
                    this.$$set($$props);
                    this.$$.skip_bound = false;
                }
            }
        };
    }

    const icon_pause = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-pause"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>';
    const icon_play = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-play"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>';
    const sound_tock = 'data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//uwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAPAAAnLgAfHx8fHx8vLy8vLy8vPz8/Pz8/T09PT09PT19fX19fX19vb29vb29/f39/f39/j4+Pj4+Pj5+fn5+fn6+vr6+vr6+/v7+/v7+/z8/Pz8/P39/f39/f3+/v7+/v7+////////8AAAAATGF2YzU4LjEzAAAAAAAAAAAAAAAAJAXQAAAAAAAAJy5E9QP3AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/+7BkAA/wAABpAAAACAAADSAAAAEAAAGkAAAAIAAANIAAAARMQU1FMy4xMDBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/7smQAD/AAAGkAAAAIAAANIAAAAQAAAaQAAAAgAAA0gAAABExBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/7smQAD/AAAGkAAAAIAAANIAAAAQAAAaQAAAAgAAA0gAAABExBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVEhwARkGZv0i2X0zsORIInEi/hrWd4gKbrF7DIg7QDmAlZ9dHlIGOF9yy6C7/LCPxapJQ7DuQ5SXX/XYsSTPu1tr7v0zsIB0i3HoGsLsa5LXbVI1yKYyuNxu3Uf9y3Li7wIJC0iaiq5jEGMArBH3/l9SWV4YhykxlcbjduUNbd+1DD+P5GLMNuQ7lmJu278Py+nsfrDCUQxLLsMP47ksqu25bluW1yKRNh6gaY7B4ksIgHTDhbAC4AAAAwCaiq5jEAYhvVM0w3XjjkSy5GJZSYw278qXIgHRTafQOw7ksibvu5Dl6JsPWHYm/ccVOseB6kYsYcr0mHyt22dtffuga21+f+u7bv0cMM7d/P8LHM6ekwr09Pb1hzDDDCkjFIEGxfMYBDFiIyQeDhwwMdMtLQUfmRJRyMybexmnm4YZmDExniUagmGeCxg5mfDseyobQcSgzHkTGg1xq2JEIprHhb6LCLEdSA13pEKaS1ra72Jv3WlkbtxB3KV22vyNwEV0i2XzzoLCLEgRpZbAvAridVvLZoLv8oAWnQXf5EwtgWQQUe1c5bBAA5jS1TqnVO87KC5aC7//7smTaAEAHAIAAQAAIAOAQAAgAASN90Fk1jIADl6bH1regANMMcSzbwrv5GJRLKtPcvOGmIoI4lFXp7dx2FTrrh5hjXHcikFrvTEYJBq73XjjWHEvQw1h3JZQsrUDbdgBgQYCDoLvO6CXiKjQEMzFDDFBFAgAAAA/0KTInTrOQM1/wUrZCZOYZ5//DElQErNcZLUNA0RQDEAABBYGGC8OkFBigwAgIuIveMmGqBZBECMJ0c0WZ8SmM2T4uA8VThDSCjg/pEUNAGABOjlGoxoCA4BTET7/Ny4XGHPJM0QJQh4gIJxEBgbz/8WQVSfHeJsE4DBEFyTKoX9EHCAgULg2iAAVDRgJC//jWDVB4LgxlhHgBxQQjFjIUiAApwDBBwbyA3YBhxAQGwOMVChQL3ALhgyH//yfELjfHAJ0JUcYeuNQZAWAZcri3jmAYwcAoFBsCAxZMXKAIDAsSE8AiRgmDBARGMBQOACMC8f////YZckycFwFEiZPmBUHYQ8r//8Y4XoQgABQYskG7RHwg4RkINC1Yn0Ll/5d8wYcHGmSd6JB1bzMwjLL9cMGNBxs2BcSCNA+OAOIAQMG4eJ8FxkXC50ixb83IIRQ0JMi50u/TL5ubmbGorxUJ383IIXECDkXJY2KgzhDjH+bk4XDQnzdzA1KBFy8ZH/+kTBoXC4aFemL4rjGkOKZmIWI8uf/JwuGiZmbldCMgXCAmAxpSMBWA+Qh4uEulT//oJmZu5gaIM7oMaKIuViGjWOFsjSaJknjIi5dJki3////oF9Ny4XDQvl9zf//59ZfL42SeIa5PECNi+4BgAAAkNXoWJoTFhjs6m//7smT/gAkZiLiuaoAAzREWwM1MACXmIwJY/AAD4cRgRxmAALAq2NzN1PSOOGEvs5UnKTCM3reqn4Z9w3TUlPnezt4Zcu542pZSW8+1LWG886eclDOl1JiyRcqPWN6vT3ezksxrv3nG2QxnjvK3QS+0opqSrYrxubxjdJDkbp4xK24xyBW9YmvTTsF36G3HI1GJZGKd061E/bzPK7b9xh35HGVB0rLS9C6ZdBW5loYNE9GR0Y29TbPo/DocVvVK3ONxp+XXeZoEbi0OvO6zyuu20sSREsmcJcgziIom1ZI0RoDmA6BhejoEWCMMCYvBisEBKAL7UITvSCYenmnws8LAmoMiNHA0to4eqzE1Qyj/////////8xlHBppIUIqBULPEkkREA6yV5K8//////////ZokQoKRDc0u3GUU1kKwNkW42dAACW8dh29Ej/Xp4mi2rsYjG41/JynzemVRr//43G59/pmdlX8/4xLPsSjq8WOyFOb/1r4puVy+L4MLk7aqBNKcPHH7vf+c7hhu20BYV6nTnodyuZa3z86Sk5hDEUht/5/OlhmJNOfGVsMRG/v91+GU289C68veBtFLJX2T3kAwoUGIRFCHGAoWOXECFgYyNtW3Ho1cmK2o/Ga8vh/KxY3/7/Dne6R0dRbzeymKQ/HZJZpHxoI1SU1HqWVpZXk0fkcrkcskboYfvPPXLG+9///////////43d+GJyTymneSLy7OMf/////////zkYlsXsw/8PzEgoJy2hRAoAoAYO2rXdi/Ym3RP9pa+uv16+v1/b31+6/62mR1VDmKhjtWi0bUoKUGQx0KUSGnYeJKMP/7skQbAARdh8QuCKACl9EYgsC0ABQCIyO4I4ACY0RkZwJQAILOzi6nodhAVHDhggMMJIHTigoJiBBESF1FBYPCIUzjgFECsMFFFxQ4DoMGiwQDAoeLQOHw6A40yg4b//wmcCqJBYYKjwFKKDf/+cSAjgGQTAceLirYAAAAIwQkoQ8Zfft/t/7W//Umv/XV7oN/ZddlbMm79dJTrSoIpLoKTTWgp0EGorRZJSS1IpJqZSKbOkmtI8XymbInTEcBMRRZVJJJJFaLItQMGNzNIuGBQHebkuSBYVFAchBEzLUhGxgxzkEnj+EgFgZJJI00UUUk0kv/+YGybGqRmkUFHy///5gQCgNpDG4fhLxPzMwNykTAYAgAAAGIwkEgYYiStUBgXQGD9n///+tk+6Kio5qt+u1Uus3/WjXRHVWO/9KOrzShcqVLDYbDYaoky7LVShUqNyw0CUajYqNB0sPFBkajUiNhUTU97ojGIQIqWKjxhxckPDpQ8dcasIo6RHSAuEYfIiKNBeD4dEgIQsrnnnnHHmIzN//yhphJxs48cPkjyP//HxsKREDIRCc4RRQREoToLCggHnlColCGEyMRGyCHZr7//6XdVY3zGVFRyq36vZiojqpf9WRpkuqlMurNQtKOppUdVYxnKiSTMWqkGlOKigqHRIaICI4SGDw6HRweCQOrvcySIOLYaJEMPDwkIjBMOnDooAodKIsPDx2CIgLgYaHAFCSu6hpjHRGDG//4UUgNAJwkYLMcF//4TAIIgAAIBBMwRCAYAQXVgt3v/t/38+mrtMYZBA9/4b/dJNRk56J5VDcMRxo6gdh7OE8+VGrB3v/7smQUAAYtiM9uPWAAZuMpHcgwABgZW0/5h4ABp0GnIxsAAD6N7Ceb2nbzpeOwdhyjc+chrklLcUEwdZPliEvY62ulj2ksnkw07m+bVbrU9jINDhPP3EwzZTqd3se26emfJjOCQTJdMw+WPut7Im7Y+YJ58+dHeXjsHYWHjTc3dMQ9jHsq6q2RN2x8uZTzgCYey8dFHw8B4HwBsvzcd9NdtiZien/////w6n2zbdVP////+P4DBMOLkgmDrHeT1jd4ABA4hOp9OSICAAAAAFXU1b+F8Q22qpnv1wngYUFUSo/t68AAGg+MOsPbO8uEgsFuVnQmppcPuCRUjwIcVv/fT9Tlq/fzcK9/CAj15kUagBH4HAyR5soKH8Af4wUlDAQ/wWHhcBgqvaqIeaWZGISoH+xtuEkkEBVgYtZKsy9lKHOTAUymVLGErMj8NO015WAvBnqRmNRyP+VNvfBFgA4GUii9lkXR7VwajIMRmMiAssayb79zc2C4aCuHAWqshv3bx2wV800OHOj2R+j5oECK/iscOM8ganu2v1XJO/eyv56ObU8tEz61rNjO7Wxb6z/3BrV8FRzq9mYHNkktBtlhy9rXX+8/P//cYEWHEds0t8P4rjCERZQFWExm6rpDIMkg8EhF/LEWiUMkMwIAgAD5VrkoPvgtwGZtEMHr8LqAVBS3+J0EMHcHSf+J0OC5CFLn/5fGmeL5E//+mV7m6Cf//5ugxgimkiT//29frReiV1FdUrlD//q+zet5USQQKRBCmWlSCEeW1L/////////yFH++iBiVR15I5ChDQyHkFSDRpNFmC1afzOnCXcghTecRRv/7skQQAAQOMtQGawAAgMVaMM3gABCQ0UAZvAAKAJjp/zDwACvElDwu8QgTBkKcLSpD1O0KHGXCwV6ypmAVM/12lk4+kLkA6EgAUOnnE9n+l8P3t0+lAExEq4MeCA5a6TjWtdsXs//4Yh67KKa7cx3jj//+f///WqhQHAqx/9MBpM//hCq/pfTZVFOITi/BfAxSLAy4ZSXRgBAgJA0pmHNKVuEQ0lmmKIQ5HEdwrULiQVkyTLDs38SlCiRWgkVXs0vgKodKdfx/B+oVQA6IWAY8/IEQn+n2mUVE4k6kIioje+DYHrnXScae18/hz+adCHqGORqh0LgrnERGpJpn+WFjwYAn/7a8xwIxQ+jw6EmiFxqoqc+FmShxjA6raYeBmEBRfd8nFYaj6PWQvhiGXFHSgnZiULFzRhj2M0nGayAj4r50V+LAogv9NRrZ7EETP1kkRLzSUEsMP9JdZ4/xIUcSjs9bbOK4s3DuMzz+b/PUNOtakFLNV8cd4a39jW899wv3srmYiGs//2RZNHEAU4RFIjIkKakskkggAmiqPJRVso5ouOiIGlVyu6sXMGUtg4j8XmG8HKM1VLpVJwNYYbS9R1bZOFGjCAefDYl09zFkJaqCRylhkYv/rNt4akkcsBlkZoTUzw5PqHe8A5S2ule7VuPFniUviJArHlniF3HYCBco2DAePvctv/SqaqqqqoAAAAWqvujhaq0DKWuGZD6uVGnIhyNSq1sWBoSHrWYKGGKOWOalkyg6/0SoDjgWX/8UYhTBM3Wwt/+PAEDwSh4a4NsoG23//qWI44OzzFaGUZdWe3M7t7IQOt7pzzOq0RbH3P/7smQzgAQ0Zk9OYQAAgEqKX8wgAFB5mTf88wAB95hmP57AADKKkjD3HnixY269+LiuP3RKcvpP6e1cfbuwuWo85heWVjVZeoimZkUCgSEgSHBtneCyc6upQuWMKQazLriFEMQ7TSusHQlgeJSzxBAXGlHxOH6g3HhyU4r/8IeR8Em/+IgjjKgyFWoK//sBQFhiI4NsoOtV//5Fz1e+E5Vr////7IMtI5enUdCrXezf//+eZcHkIejtgLVgVlT8jqvDz6pqjepd2b/WxEMoBSg1SXhGNpWgqiVGskTwQ5zrhhJLOHkUc2dxjQn82JRw2fMA095n+iWPLVTVXnKrtTY1Vv8zT/zMzn/nHyvPn//15z52rvnn+u2fO/2qecdu1NPf/K9POfG9a+f121kfJ1nJFJciU5STEskrwlpKzmuEmSB4HzPi2bWXRmeGVbZIyAeoRXTibAO4MgIeEpOMcK6Q2KGaQQnSqbAFNT6yZHPlMfUx9Y6XblTpd/HT63mnrTb2Xdaer0ret7V1vLVuPWZW9O9a2Vy1tgXTbrf1o+OkVAUFSw5YaAoXGgCIRSw2SWOayp1G/efEBe5Y0cQeNYerNy72fRUFBAr6AA/kOQqE5DdL4LEXVXoT5n0sXD7rWes98rWVq3kp7VmFc0uruGS46WuzM5VataXWXfaen+2uTm5A9Na2m34u/P7a69M1qtdrLV4vm2LmiSpsubiMo0p9w5E6M5iHkdbQrDsCKnnloFQMmLDYnB9z5lADZs6bWhKPo9B86XwphBqwVgBTgpnioOiMoLRlwhHQAR+hDyiB4XJDcsl0AtSyY4OJcK6AnKgfF//7skRWgAarecPNPYACzq8IMaY8AFJqIwAYZQACYMRfwxcgAEPXnAbQkpOkTJzg3RRxIyySSs8uKqQ/cbXqVx6dHMDJeYfcjcjdVRU4AfkEBuOiEQx9EJEJUcnLttzVaMT7OvbG9ffivYtt2vq0J9v/Na++v9W/rT/W8W+s6+f7f//6tv7xnFa+1n19XYlc5V9tvWFinzBpdlwxTK6GrWVqZk8tWblcfxcl9DVSnoEZ9K8dxVyXGGT0XFkZlc2wI7e4tah66IUxl9J0xup2EtqUUWHhOmkuohqonUy7SKVfG8glDCwaTY+OaGkjKUR6nDRraDSjOZotj/aeRZk9dNJ0vWZho+P5jaGbDUom1OqFdM2k6/iNbxyilA8zKx7Zb/YFJ980KEw06oXwxHtTDqiwKqjUhOxuw/MYYljL2OlkMFj7+uYhtZj//kbSQ0nERq3+ftyMiHh9BLE/n/+ymPmQtjQbi2eeTkZOeI/6FCdMflszqiPJ5YwgBDA+IQWwK4LgWQLBcDQKBkODgpGKTVIDBiLOn//ki2IB6Wj+Vci//7hTlLiwWFAhgKgmDQkE1FVE1itt3t/1Sek+gXGq5uQdSzLUvNyccuTj/0S8RAnDD/3okgZm6SH/+XCmQ4ZAxKxBP/UyHyWIcLYMAi5Ey2P44//obfyDDhEExYyoRMwI8cZSFD/9arLu/0G9TCfwFTFbilwGrFwCUwbniMgsUGyNMghDyJLrNTpdYxZJReL3///2///iCAsZDDQ2LhoNgQXSIuNQTgoAaD8fb/f///fWxKJoD9nMuACAEuG27Qw+CsVkOq+sJ0wuThWU0PhnPEZOYv/7skQWAASAXM5uCSAAkSuZ/cMgABMBXzm49gAKa6umNx7AANZrya/8O2gh5zlUt8dhm+erisnZC4bj7QyauvLz+kkUYIEnFAYJKalUkUaRb635ddogJCf+EIFACXH3G/JFdb////5khsgEgFt8VhsnZIzZJcosxihQ7asjwi5fpOY0HP9PqBoUf/////637/+yIAgED/1/Gkje5gQjN6AHPJBq7oAuC8FNitu55YNw/FWtd/EUG4fhAWUdMHPe+Lh5Vu7bRK3P72WLi5oKwjXkkYdMVzXZknh4ZigeGQzbFe3//7EGX8JRAcTX/w3///+Hh5BgLxeAbgvD9Rc8yYVVkVDm1FSjYdKMBApOROck1gQv/VkiMRf0y3e77/f3++37eat2DAfHzl/qsO1Ab+4s8IWNnfbut8cG1kV/wRAHroj9u69afsGC4Gg6MO0RpXljbr5WAEDxcofXIl8ahx51uvuDgDQsP6+vsvUFzOybbVmx45Sm3977NXYXVyzVVrOLmp39ndmVaPVmd1KGa/mazNfmbWmZmZmZmScOg4Jl5kZII/D+OBeqP5vaKSCopIa3XFYpFabDWbFY2kkCB5q6ay55rbNAB/pi+g61uK1suPB9667dREAeuPoIDq+r2DxcDQKLeuTS84vdfJQAAeHxgbFpEZqzxyzi/bKBwA4WH9O4US0umJ73V34IIyYedO+cmKk5JKwqlmDa1ta21r1/mZvMrXWGc+fZgtnzMzOzOzMzMzMzJyuKZ7Jyesk1ElMaLVoSBoSgsDX/nCQAEWyiIAAMAIQqxdT/chw70LjQzCE50vJYny6k0GVZqkSCjflz0v/7skQTgAS8O8VeYyAAmGeJP8zkABEQ1wlZnAACLCOghzOAAq7gsvaBA+v2/4tccSRmJMRiyNxipROxOVn0g+VrJLmhgrBWEJVNcfyVXouXMYYt2jhgwxFAXBlMLoJHG3/obtV9mmOhQUeDxSaLQ93Uz25hy33KU5dx7zVSmt/Yws2f1r9/l//T3UVJKSNdhXeX/d6GZjJmeJd1VgAwECpbZQAAEuCaABHL+Yo+ZuuAoaCXDNqQHG1BoFE9QI4WBJY0Cz0ZgJnjWkJMFgAszE75dxUhiBqMpLv7aaUhler1+uzSyhCc0lgr+wY7UbjdHq4zGw165XTGdmHd9psIxLLPMWUyKSxnWDSp6DHevVZm7G5XR4XOOlEb0q3+5qLWN/yls/3/3///1qbM3CYACkCAAAAAAAAAiaXAqlF3cx4ZlZvRpzR7WZyGjQLvOF3y8pmHdpf9Lhhahtn5T+ODDV8gRpy/DNamx/H/C7AcZscXBA9Rp/ojDuv/+mp6CZSTxwVnS52ZTNS7ev1/sBaUzp+t5Z38scqtn+b////tXN/KqWlGBU8sNdjip/2PndlHcs1Ro339QAAiL5jEtrI61oz8jJMdGvjkJDPXKZTldaUoN3X7XVJpZllW1v+MyBojPCtjZ1rWPC8qAFrscL/blMt+1/OfwAgVtZbAtp9o1Wpr9rHH/xx05V7GU3JdTSnlLhS4U2WWP6/6tathU/nO6ps627O7Nz/3zH8f/efa+Nn+fh9XCm1aB4CiXL9xc/7vTVUAbzyRJwbBHSwa1MliQkpQCWcl5/ZgYBODLkiWrTUfCUtTBVwsFCdnDSOdykf6+Vm////7smQZDuOuZ7mPJMAEeo0HIeYgAI51FLgGJM/J2KVXRJMmOTlEneC0cr7jPTz21jZYlppEwlOVreiWyzuqq0GRYls9wXDq04d7yvM558z5755//+Nv8vWvPfPWtvbfX3//9p5qP/pIAR5A7E0fQuXTHLDbo5AeVntcoeIQLnGHFG5KSU4cg1GgpCEWh6xgrQscMD6W8qYJHWuUPDk2pHMUhNU21xSxMNcXkmocrbh0HzB0PXxhosdc5IrXWVZI7+RWm4OyRWa5i1hmualVWNm2/9pr/9m2aK//i5r//7WvyTbrR5bk+YhMQCOWTptx5bA5aeSv9aBMQqNsy2Nw3JRREJY4jYfGvGslNmScHobZRJoHkoqGS55qP9bE0o9SRE40UBJo08bLM8blTRtonWjT5VPRpR6CRuy3+NaIKKPAxLNT6ktv/waGqxzd3//aVSU7H2RSsZisu5EVQCYBS55pVJslIjq7Gxp4XL5uVLXmokhIhNFJ/lf5RpiJK0SRcJETUEiJzsaKAkwkGLQSInHE1BREq41+1qJGmNy2NTc0hLKPZrY08UiEgPkpEuw0rNmX/+xVSm5qMrqrxqMqIqJdkTEq8+3/opf0pWZMQU1FMy4xMDBVVQARhihxX0NwWjRJEbCFo1RMMlw9qCgUCJoLXWP/2JIPHHElDZS6jphr18SgsCkQRQeObmmppjiUYqUcwRgagqAaGQ4FzB5rTU////9rFsowsccSjQytKWusTV/cusfTElFDSDzRYVB4BoZDwTrsSUNlP/YVGmD1D5ZPJTcTBUFgOFY4TIUnoVqnDY1NkiONsok2GkKTmrhsZXlbGv/7smROD/O4XBmR5kMgdQsDMSQJwAAAAaQAAAAgAAA0gAAABJJmQSB4nFiYhKGyUiYJlYbGVxjnlGnxlJCWLkhoUll991sfLxWKqHyUiVSSm5EnDf/////4rLnhUISiOcN2KU83/+VuRFU4Wku4mISyS8HxTEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/7smQAD/AAAGkAAAAIAAANIAAAAQAAAaQAAAAgAAA0gAAABExBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVQ==';

    /* src/Metronom.svelte generated by Svelte v3.47.0 */

    function create_fragment(ctx) {
    	let div3;
    	let div0;
    	let t0;
    	let t1;
    	let t2;
    	let div1;
    	let input;
    	let t3;
    	let div2;
    	let raw_value = (/*mute*/ ctx[1] ? icon_play : icon_pause) + "";
    	let mounted;
    	let dispose;

    	return {
    		c() {
    			div3 = element("div");
    			div0 = element("div");
    			t0 = text(/*bpm*/ ctx[0]);
    			t1 = text(" bpm");
    			t2 = space();
    			div1 = element("div");
    			input = element("input");
    			t3 = space();
    			div2 = element("div");
    			this.c = noop;
    			attr(div0, "class", "block");
    			attr(input, "class", "metronom-slider");
    			attr(input, "type", "range");
    			attr(input, "min", "40");
    			attr(input, "max", "256");
    			attr(input, "step", "1");
    			attr(div1, "class", "block");
    			attr(div2, "class", "block");
    			attr(div3, "class", "metronom-body");
    		},
    		m(target, anchor) {
    			insert(target, div3, anchor);
    			append(div3, div0);
    			append(div0, t0);
    			append(div0, t1);
    			append(div3, t2);
    			append(div3, div1);
    			append(div1, input);
    			set_input_value(input, /*bpm*/ ctx[0]);
    			append(div3, t3);
    			append(div3, div2);
    			div2.innerHTML = raw_value;

    			if (!mounted) {
    				dispose = [
    					listen(input, "change", /*input_change_input_handler*/ ctx[3]),
    					listen(input, "input", /*input_change_input_handler*/ ctx[3]),
    					listen(div2, "click", /*toggleMute*/ ctx[2])
    				];

    				mounted = true;
    			}
    		},
    		p(ctx, [dirty]) {
    			if (dirty & /*bpm*/ 1) set_data(t0, /*bpm*/ ctx[0]);

    			if (dirty & /*bpm*/ 1) {
    				set_input_value(input, /*bpm*/ ctx[0]);
    			}

    			if (dirty & /*mute*/ 2 && raw_value !== (raw_value = (/*mute*/ ctx[1] ? icon_play : icon_pause) + "")) div2.innerHTML = raw_value;		},
    		i: noop,
    		o: noop,
    		d(detaching) {
    			if (detaching) detach(div3);
    			mounted = false;
    			run_all(dispose);
    		}
    	};
    }

    function instance($$self, $$props, $$invalidate) {
    	let bpm = 100;
    	let mute = true;

    	function startSounddevice() {
    		if (!mute) {
    			setTimeout(
    				() => {
    					let audio = new Audio(sound_tock);

    					if (!mute) {
    						// avoids playing the last sound after muting.
    						audio.play();
    					}

    					startSounddevice();
    				},
    				Math.round(1000 * 60 / bpm)
    			);
    		}
    	}

    	function toggleMute() {
    		$$invalidate(1, mute = !mute);

    		if (!mute) {
    			startSounddevice();
    		}
    	}

    	function input_change_input_handler() {
    		bpm = to_number(this.value);
    		$$invalidate(0, bpm);
    	}

    	return [bpm, mute, toggleMute, input_change_input_handler];
    }

    class Metronom extends SvelteElement {
    	constructor(options) {
    		super();
    		this.shadowRoot.innerHTML = `<style>.metronom-slider{padding:0.5em 0}.metronom-body{display:grid;grid-template-columns:auto}.block{font-family:Calibri, Candara, Arial, Helvetica, sans-serif;font-size:x-large;display:flex;align-items:center;justify-content:center;width:100%}</style>`;

    		init(
    			this,
    			{
    				target: this.shadowRoot,
    				props: attribute_to_object(this.attributes),
    				customElement: true
    			},
    			instance,
    			create_fragment,
    			safe_not_equal,
    			{},
    			null
    		);

    		if (options) {
    			if (options.target) {
    				insert(options.target, this, options.anchor);
    			}
    		}
    	}
    }

    customElements.define("metronom-bpm", Metronom);

    return Metronom;

}());
