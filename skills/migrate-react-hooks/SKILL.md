# Playbook: React class components → hooks

Plan mode is on. The goal is the same behaviour with function components; nothing should look or act differently. Plan it component by component, leaves first.

## 1. Inventory

- Every class component (`extends React.Component` / `PureComponent` / `Component`), with what it uses: `state`, lifecycle methods, `refs` (string refs, `createRef`, callback refs), `contextType` / legacy context, `getDerivedStateFromProps`, `getSnapshotBeforeUpdate`, `shouldComponentUpdate`, instance fields and methods called from outside (through a ref), HOCs and render props wrapped around them.
- **Error boundaries** (`componentDidCatch`, `getDerivedStateFromError`) stay classes: hooks can't do that.
- The React version (hooks need 16.8+), and the test setup: React Testing Library tests survive the conversion; Enzyme tests that use `.state()`, `.instance()` or shallow rendering of internals won't, and need rewriting to test behaviour first.

Order them: leaf components and simple state first; components with tricky lifecycles (snapshots, derived state, imperative handles) last.

## 2. Conversion rules

| Class | Function |
| --- | --- |
| `this.state` / `setState` | `useState` per piece of state (or `useReducer` when updates depend on each other); `setState(fn)` → the updater form; remember `setState` merged objects and `useState` doesn't |
| `componentDidMount` / `DidUpdate` / `WillUnmount` | `useEffect` with the right dependencies and a cleanup; `useLayoutEffect` where it measured or mutated the DOM before paint |
| `componentDidUpdate(prevProps)` comparisons | effect dependencies; a `usePrevious` ref only when the old value is really needed |
| `getDerivedStateFromProps` | compute during render, or reset with a `key`; avoid mirroring props in state |
| `shouldComponentUpdate` / `PureComponent` | `React.memo` (with a comparator if it compared specially) |
| instance fields (timers, flags) | `useRef` |
| methods called by a parent via ref | `forwardRef` + `useImperativeHandle` |
| `contextType` / `<Consumer>` | `useContext` |
| bound handlers | plain functions; `useCallback` only where identity matters (memoized children, effect deps) |

Watch for stale closures in effects and handlers, effects that now run twice in StrictMode, and event listeners added in `componentDidMount` that need the same function to remove.

## 3. Plan

Batches of components, each a PR: the components, how behaviour is pinned (existing tests, new behaviour tests before converting, a visual check of the screens they render), and the conversions that need care. Leave error boundaries as classes. Milestones per batch ("all leaf components converted, tests green"), then `present_plan`.
