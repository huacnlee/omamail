// A window of its own for the ui gallery: `nsh run src/ui/GalleryApp.tsx`.
import { mount } from "nsh";
import { Window } from "nsh/desktop";
import { Gallery } from "./Gallery";
import { followOmarchyFont, setThemeMode, Toaster } from "./index";

mount(() => {
  setThemeMode("dark");
  followOmarchyFont();
  return (
    <Window id="gallery" title="Omamail ui" defaultSize={{ width: 900, height: 900 }}>
      {() => (
        <>
          <Gallery />
          <Toaster />
        </>
      )}
    </Window>
  );
});
