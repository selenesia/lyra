use crate::constants::{MOCHI_PREFIX, PART_1, PART_2};
use crate::encoding::encode_mochi_url;
use lol_html::{element, html_content::ContentType, HtmlRewriter, MemorySettings, Settings};
use std::cell::RefCell;
use std::rc::Rc;
use url::Url;

pub fn rewrite_html(
    body: &[u8],
    target_url: &Url,
    base_url_str: &str,
) -> Result<Vec<u8>, lol_html::errors::RewritingError> {
    let base_url_owned = base_url_str.to_string();
    let current_base = Rc::new(RefCell::new(target_url.clone()));
    let base_for_updater = current_base.clone();
    let target_url_for_base = target_url.clone();

    let rewrite_url = {
        Rc::new(move |url: &str| -> Option<String> {
            if url.is_empty()
                || url.starts_with("data:")
                || url.starts_with("blob:")
                || url.starts_with("javascript:")
                || url.starts_with("mailto:")
                || url.starts_with("tel:")
                || url.starts_with('#')
                || url.starts_with(MOCHI_PREFIX)
            {
                return None;
            }
            if url.starts_with("http://") || url.starts_with("https://") {
                return Some(format!("{}{}/", MOCHI_PREFIX, encode_mochi_url(url)));
            }
            if url.starts_with("//") {
                let full = format!("{}:{}", current_base.borrow().scheme(), url);
                return Some(format!("{}{}/", MOCHI_PREFIX, encode_mochi_url(&full)));
            }
            let resolved = current_base.borrow().join(url);
            if let Ok(resolved) = resolved {
                return Some(format!(
                    "{}{}/",
                    MOCHI_PREFIX,
                    encode_mochi_url(resolved.as_str())
                ));
            }
            None
        })
    };

    let rw1 = rewrite_url.clone();
    let rw2 = rewrite_url.clone();
    let rw3 = rewrite_url.clone();
    let rw5 = rewrite_url.clone();
    let rw6 = rewrite_url.clone();
    let rw7 = rewrite_url.clone();
    let rw8 = rewrite_url.clone();
    let base_url_for_head = base_url_owned.clone();
    let base_url_for_html = base_url_owned.clone();
    let script_injected = Rc::new(RefCell::new(false));
    let script_injected_for_head = script_injected.clone();
    let script_injected_for_html = script_injected.clone();
    let base_for_href = base_for_updater.clone();
    let base_for_style = base_for_updater;
    let mut output = Vec::with_capacity(body.len() + 2048);
    let mut rewriter = HtmlRewriter::new(
        Settings {
            memory_settings: MemorySettings {
                max_allowed_memory_usage: 4 * 1024 * 1024,
                ..MemorySettings::default()
            },
            element_content_handlers: vec![
                element!("html", move |el| {
                    if !*script_injected_for_html.borrow() {
                        let full_script = format!("{}{}{}", PART_1, base_url_for_html, PART_2);
                        el.prepend(&full_script, ContentType::Html);
                        *script_injected_for_html.borrow_mut() = true;
                    }
                    Ok(())
                }),
                element!("head", move |el| {
                    if !*script_injected_for_head.borrow() {
                        let full_script = format!("{}{}{}", PART_1, base_url_for_head, PART_2);
                        el.prepend(&full_script, ContentType::Html);
                        *script_injected_for_head.borrow_mut() = true;
                    }
                    Ok(())
                }),
                element!("base[href]", move |el| {
                    if let Some(href) = el.get_attribute("href") {
                        if let Ok(parsed_base) = target_url_for_base.join(&href) {
                            *base_for_href.borrow_mut() = parsed_base.clone();
                            let escaped_target = parsed_base.as_str().replace('\'', "\\'");
                            let injection = format!(
                                "<script>window.__MOCHI_TARGET__ = '{}';</script>",
                                escaped_target
                            );
                            el.after(&injection, ContentType::Html);
                        }
                        let proxy_href =
                            if href.starts_with("http://") || href.starts_with("https://") {
                                format!("{}{}/", MOCHI_PREFIX, encode_mochi_url(&href))
                            } else if href.starts_with("//") {
                                let scheme = target_url_for_base.scheme();
                                let full = format!("{}:{}", scheme, href);
                                format!("{}{}/", MOCHI_PREFIX, encode_mochi_url(&full))
                            } else if let Ok(parsed_base) = target_url_for_base.join(&href) {
                                format!(
                                    "{}{}/",
                                    MOCHI_PREFIX,
                                    encode_mochi_url(parsed_base.as_str())
                                )
                            } else {
                                href
                            };
                        el.set_attribute("href", &proxy_href)?;
                    }
                    Ok(())
                }),
                element!("link[href]", move |el| {
                    if let Some(val) = el.get_attribute("href") {
                        if let Some(rewritten) = rw1(&val) {
                            el.set_attribute("href", &rewritten)?;
                        }
                    }
                    Ok(())
                }),
                element!("script[type]", |el| {
                    if let Some(type_val) = el.get_attribute("type") {
                        if let Some(dash_pos) = type_val.find('-') {
                            let prefix = &type_val[..dash_pos];
                            if prefix.len() >= 8 && prefix.chars().all(|c| c.is_ascii_hexdigit()) {
                                let real_type = &type_val[dash_pos + 1..];
                                if real_type == "module" {
                                    el.set_attribute("type", "module")?;
                                } else if real_type == "text/javascript" {
                                    el.remove_attribute("type");
                                } else {
                                    el.set_attribute("type", real_type)?;
                                }
                            }
                        }
                    }
                    Ok(())
                }),
                element!("script[src]", move |el| {
                    if let Some(val) = el.get_attribute("src") {
                        if let Some(rewritten) = rw2(&val) {
                            el.set_attribute("src", &rewritten)?;
                        }
                    }
                    Ok(())
                }),
                element!("img[src], input[src], track[src]", move |el| {
                    if let Some(val) = el.get_attribute("src") {
                        if let Some(rewritten) = rw3(&val) {
                            el.set_attribute("src", &rewritten)?;
                        }
                    }
                    Ok(())
                }),
                element!("img[srcset], source[srcset]", move |el| {
                    if let Some(val) = el.get_attribute("srcset") {
                        let rewritten = rewrite_srcset(&val, |url| rw8(url));
                        if rewritten != val {
                            el.set_attribute("srcset", &rewritten)?;
                        }
                    }
                    Ok(())
                }),
                element!(
                    "source[src], video[src], audio[src], video[poster]",
                    move |el| {
                        if let Some(val) = el.get_attribute("src") {
                            if let Some(rewritten) = rw5(&val) {
                                el.set_attribute("src", &rewritten)?;
                            }
                        }
                        if let Some(val) = el.get_attribute("poster") {
                            if let Some(rewritten) = rw5(&val) {
                                el.set_attribute("poster", &rewritten)?;
                            }
                        }
                        Ok(())
                    }
                ),
                element!("a[href], area[href]", move |el| {
                    if let Some(val) = el.get_attribute("href") {
                        if let Some(rewritten) = rw6(&val) {
                            el.set_attribute("href", &rewritten)?;
                        }
                    }
                    Ok(())
                }),
                element!(
                    "iframe[src], embed[src], object[data], form[action]",
                    move |el| {
                        let attr = if el.tag_name() == "form" {
                            "action"
                        } else if el.tag_name() == "object" {
                            "data"
                        } else {
                            "src"
                        };
                        if let Some(val) = el.get_attribute(attr) {
                            if let Some(rewritten) = rw7(&val) {
                                el.set_attribute(attr, &rewritten)?;
                            }
                        }
                        Ok(())
                    }
                ),
                element!("*[style]", move |el| {
                    if let Some(style_val) = el.get_attribute("style") {
                        let current_base = base_for_style.borrow().clone();
                        let rewritten = rewrite_css_urls(&style_val, &current_base);
                        if rewritten != style_val {
                            el.set_attribute("style", &rewritten)?;
                        }
                    }
                    Ok(())
                }),
            ],
            ..Settings::default()
        },
        |c: &[u8]| {
            output.extend_from_slice(c);
        },
    );

    rewriter.write(body)?;
    rewriter.end()?;

    if !*script_injected.borrow() {
        let full_script = format!("{}{}{}", PART_1, base_url_owned, PART_2);
        let mut new_output = Vec::with_capacity(full_script.len() + output.len());
        new_output.extend_from_slice(full_script.as_bytes());
        new_output.extend_from_slice(&output);
        return Ok(new_output);
    }

    Ok(output)
}

fn rewrite_srcset(srcset: &str, rewrite: impl Fn(&str) -> Option<String>) -> String {
    let mut result = String::with_capacity(srcset.len() + 64);
    let mut rest = srcset;
    loop {
        rest = rest.trim_start_matches(|c: char| c.is_ascii_whitespace() || c == ',');
        if rest.is_empty() {
            break;
        }
        let url_end = rest
            .find(|c: char| c.is_ascii_whitespace())
            .unwrap_or(rest.len());
        let (mut url, mut tail) = rest.split_at(url_end);
        let mut descriptors = "";
        if url.ends_with(',') {
            url = url.trim_end_matches(',');
        } else {
            let mut depth = 0u32;
            let end = tail
                .char_indices()
                .find(|&(_, c)| match c {
                    '(' => {
                        depth += 1;
                        false
                    }
                    ')' => {
                        depth = depth.saturating_sub(1);
                        false
                    }
                    ',' => depth == 0,
                    _ => false,
                })
                .map_or(tail.len(), |(index, _)| index);
            descriptors = tail[..end].trim();
            tail = &tail[end..];
        }
        if !result.is_empty() {
            result.push_str(", ");
        }
        result.push_str(&rewrite(url).unwrap_or_else(|| url.to_string()));
        if !descriptors.is_empty() {
            result.push(' ');
            result.push_str(descriptors);
        }
        rest = tail;
    }
    result
}

pub fn rewrite_css_urls(css: &str, base_url: &Url) -> String {
    let mut result = String::with_capacity(css.len() + 512);
    let mut rest = css;

    while let Some((url_pos, paren_pos)) = find_url_fn(rest) {
        result.push_str(&rest[..url_pos]);
        rest = &rest[paren_pos + 1..];
        rest = rest.trim_start();

        let quote_char = if rest.starts_with('"') {
            rest = &rest[1..];
            Some('"')
        } else if rest.starts_with('\'') {
            rest = &rest[1..];
            Some('\'')
        } else {
            None
        };

        let end_pos = if let Some(q) = quote_char {
            rest.find(q).unwrap_or(rest.len())
        } else {
            rest.find(')').unwrap_or(rest.len())
        };

        let url_val = rest[..end_pos].trim();
        rest = &rest[end_pos..];

        if let Some(q) = quote_char {
            if rest.starts_with(q) {
                rest = &rest[1..];
            }
        }
        rest = rest.trim_start();
        if rest.starts_with(')') {
            rest = &rest[1..];
        }

        let resolved = if url_val.starts_with("http://") || url_val.starts_with("https://") {
            Some(url_val.to_string())
        } else if url_val.starts_with("//") {
            let scheme = base_url.scheme();
            Some(format!("{}:{}", scheme, url_val))
        } else if !url_val.is_empty() && !url_val.starts_with("data:") && !url_val.starts_with('#')
        {
            base_url.join(url_val).ok().map(|u| u.to_string())
        } else {
            None
        };

        if let Some(abs_url) = resolved {
            result.push_str("url(");
            result.push('"');
            result.push_str(MOCHI_PREFIX);
            result.push_str(&encode_mochi_url(&abs_url));
            result.push('/');
            result.push('"');
            result.push(')');
        } else {
            result.push_str("url(");
            if let Some(q) = quote_char {
                result.push(q);
            }
            result.push_str(url_val);
            if let Some(q) = quote_char {
                result.push(q);
            }
            result.push(')');
        }
    }

    result.push_str(rest);
    result
}

fn find_url_fn(s: &str) -> Option<(usize, usize)> {
    let bytes = s.as_bytes();
    if bytes.len() < 4 {
        return None;
    }
    for i in 0..=bytes.len() - 4 {
        let a = bytes[i].to_ascii_lowercase();
        let b = bytes[i + 1].to_ascii_lowercase();
        let c = bytes[i + 2].to_ascii_lowercase();
        if a == b'u' && b == b'r' && c == b'l' {
            let mut j = i + 3;
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            if j < bytes.len() && bytes[j] == b'(' {
                return Some((i, j));
            }
        }
    }
    None
}

