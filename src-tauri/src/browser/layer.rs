//! Linux: the layer a tab's webview sits in, over the window's own.
//!
//! Tauri packs every webview a window holds into the window's one vertical
//! box, so a tab would take a share of the window's height below the app's
//! own page and no rectangle given to it would be honoured. Instead, the
//! window's own webview sits in an overlay, with a layer above it whose
//! children are placed by coordinates, and each tab's webview is moved into
//! that layer once it is made. Everything here runs on the main thread,
//! which is where GTK lives.

use std::cell::RefCell;

use gtk::prelude::*;
use tauri::{Webview, WebviewWindow, Wry};

use super::Rectangle;

thread_local! {
    /// The layer, once [`install`] has laid it over the window's webview.
    static LAYER: RefCell<Option<gtk::Fixed>> = const { RefCell::new(None) };
}

/// Moves the window's own webview into an overlay, with the tabs' layer
/// above it. Called once, from setup, which runs on the main thread.
pub fn install(window: &WebviewWindow) -> Result<(), String> {
    let vbox = window.default_vbox().map_err(|e| e.to_string())?;
    let page = vbox
        .children()
        .into_iter()
        .find(|child| child.is::<webkit2gtk::WebView>())
        .ok_or("the window holds no webview")?;
    let position = vbox.child_position(&page);
    vbox.remove(&page);

    let overlay = gtk::Overlay::new();
    overlay.add(&page);
    let layer = gtk::Fixed::new();
    overlay.add_overlay(&layer);
    // The layer itself takes no input, so the page gets every click the
    // tabs do not cover; a tab's own webview still takes its own.
    overlay.set_overlay_pass_through(&layer, true);
    vbox.pack_start(&overlay, true, true, 0);
    vbox.reorder_child(&overlay, position);
    overlay.show();
    layer.show();

    LAYER.with(|cell| *cell.borrow_mut() = Some(layer));
    Ok(())
}

/// Moves `webview` out of the box Tauri packed it into and into the layer,
/// at `rect`.
pub fn adopt(webview: &Webview<Wry>, rect: Rectangle) -> Result<(), String> {
    webview
        .with_webview(move |platform| {
            let view = platform.inner();
            LAYER.with(|cell| {
                let Some(layer) = cell.borrow().clone() else {
                    return;
                };
                if let Some(parent) = view.parent() {
                    if let Ok(container) = parent.downcast::<gtk::Container>() {
                        container.remove(&view);
                    }
                }
                let (x, y, width, height) = pixels(rect);
                layer.put(&view, x, y);
                view.set_size_request(width, height);
            });
        })
        .map_err(|e| e.to_string())
}

/// Places `webview`, already in the layer, at `rect`.
pub fn place(webview: &Webview<Wry>, rect: Rectangle) -> Result<(), String> {
    webview
        .with_webview(move |platform| {
            let view = platform.inner();
            LAYER.with(|cell| {
                let Some(layer) = cell.borrow().clone() else {
                    return;
                };
                let (x, y, width, height) = pixels(rect);
                layer.move_(&view, x, y);
                view.set_size_request(width, height);
            });
        })
        .map_err(|e| e.to_string())
}

/// `rect` in whole logical pixels, which is what GTK lays widgets out in,
/// never smaller than one by one.
fn pixels((x, y, width, height): Rectangle) -> (i32, i32, i32, i32) {
    (
        x.round() as i32,
        y.round() as i32,
        (width.round() as i32).max(1),
        (height.round() as i32).max(1),
    )
}
