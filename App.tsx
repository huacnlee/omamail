// Omamail on NSH. The mail library is Rust (`ext/omamail-native`, which
// links the `omamail` crate in this repository); the screens are TSX,
// drawn with nsh-omarchy's components and NsVim's palette.
import { mount } from "nsh";
import { Main } from "./src/Main";

mount(() => <Main />);
