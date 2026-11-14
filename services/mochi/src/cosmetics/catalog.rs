use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};

pub const CDN_ORIGIN: &str = "https://cdn.discordapp.com/";
pub const ASSET_EXTENSIONS: [&str; 2] = ["png", "webm"];
pub const PARSER_REVISION: u32 = 1;
const EFFECT_WIDTH: u32 = 450;
const EFFECT_HEIGHT: u32 = 880;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub version: String,
    pub updated_at: u64,
    pub categories: Vec<Category>,
    pub decorations: Vec<Decoration>,
    pub effects: Vec<Effect>,
    pub nameplates: Vec<Nameplate>,
    pub frames: Vec<Frame>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Category {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Decoration {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub still: String,
    pub animated: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Nameplate {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub still: String,
    pub video: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub palette: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct EffectLayer {
    pub src: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub random: Vec<String>,
    #[serde(rename = "loop")]
    pub repeat: bool,
    pub start: u32,
    pub duration: u32,
    pub delay: u32,
    pub x: i32,
    pub y: i32,
    pub z: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Effect {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub still: Option<String>,
    pub layers: Vec<EffectLayer>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct FrameLayer {
    pub src: String,
    pub kind: String,
    pub front: bool,
    pub anchor: String,
    pub responsive: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Frame {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    pub inner: u32,
    pub top: u32,
    pub bottom: u32,
    pub side: u32,
    pub layers: Vec<FrameLayer>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Item {
    Decoration(Decoration),
    Effect(Effect),
    Nameplate(Nameplate),
    Frame(Frame),
}

impl Item {
    pub fn id(&self) -> &str {
        match self {
            Item::Decoration(item) => &item.id,
            Item::Effect(item) => &item.id,
            Item::Nameplate(item) => &item.id,
            Item::Frame(item) => &item.id,
        }
    }
}

#[derive(Debug, Default)]
pub struct Parsed {
    pub items: Vec<Item>,
    pub assets: BTreeMap<String, String>,
    pub categories: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Index {
    pub catalog: Catalog,
    pub assets: BTreeMap<String, String>,
    #[serde(default)]
    pub source_stamp: Option<String>,
}

#[derive(Deserialize)]
struct Export {
    #[serde(default)]
    skus: HashMap<String, ExportSku>,
    #[serde(default)]
    categories: HashMap<String, ExportCategory>,
}

#[derive(Deserialize, Serialize)]
struct ExportSku {
    #[serde(default)]
    sku_id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default, rename = "type")]
    kind: Option<i64>,
    #[serde(default)]
    category_sku_id: Option<String>,
    #[serde(default)]
    category_name: Option<String>,
    #[serde(default)]
    variant_value: Option<String>,
    #[serde(default)]
    items: Vec<Value>,
}

#[derive(Deserialize)]
struct ExportCategory {
    #[serde(default)]
    name: Option<String>,
}

pub fn is_sku_id(value: &str) -> bool {
    (6..=25).contains(&value.len())
        && !value.starts_with('0')
        && value.bytes().all(|byte| byte.is_ascii_digit())
}

pub fn asset_key(url: &str) -> String {
    hex::encode(&Sha256::digest(url.as_bytes())[..16])
}

pub fn asset_name(key: &str, extension: &str) -> String {
    format!("{key}.{extension}")
}

pub fn split_asset_name(name: &str) -> Option<(&str, &str)> {
    let (key, extension) = name.split_once('.')?;
    let valid_key = key.len() == 32 && key.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'));
    (valid_key && ASSET_EXTENSIONS.contains(&extension)).then_some((key, extension))
}

fn cdn_url(value: &str) -> Option<String> {
    let url = url::Url::parse(value).ok()?;
    let allowed = url.scheme() == "https"
        && url.host_str() == Some("cdn.discordapp.com")
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none();
    allowed.then(|| url.to_string())
}

fn text(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .filter_map(|key| value.get(*key)?.as_str())
        .map(str::trim)
        .find(|text| !text.is_empty())
        .map(|text| text.chars().take(300).collect())
}

fn number(value: &Value, keys: &[&str]) -> Option<i64> {
    keys.iter().find_map(|key| {
        let field = value.get(*key)?;
        field.as_i64().or_else(|| field.as_f64().map(|float| float as i64))
    })
}

fn bounded(value: Option<i64>, fallback: u32, max: u32) -> u32 {
    value.map_or(fallback, |value| value.clamp(0, max as i64) as u32)
}

fn hex_color(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    let digits = value.strip_prefix('#')?;
    (digits.len() == 6 && digits.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| format!("#{}", digits.to_ascii_lowercase()))
}

struct Context<'a> {
    id: &'a str,
    name: &'a str,
    category: Option<String>,
    color: Option<String>,
}

impl Parsed {
    fn asset(&mut self, url: &str, extension: &str) -> Option<String> {
        let url = cdn_url(url)?;
        let key = asset_key(&url);
        self.assets.insert(key.clone(), url);
        Some(asset_name(&key, extension))
    }

    fn decoration(&mut self, context: &Context, item: &Value) -> Option<Item> {
        let asset = text(item, &["asset"])?;
        if !asset.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_') {
            return None;
        }
        let base = format!("{CDN_ORIGIN}avatar-decoration-presets/{asset}.png?size=1024");
        let still = self.asset(&format!("{base}&passthrough=false"), "png")?;
        let animated = if asset.starts_with("a_") {
            self.asset(&format!("{base}&passthrough=true"), "png")?
        } else {
            still.clone()
        };
        Some(Item::Decoration(Decoration {
            id: context.id.into(),
            name: context.name.into(),
            category: context.category.clone(),
            label: text(item, &["label"]),
            still,
            animated,
        }))
    }

    fn nameplate(&mut self, context: &Context, item: &Value) -> Option<Item> {
        let asset = text(item, &["asset"])?;
        let safe = asset.ends_with('/')
            && !asset.starts_with('/')
            && !asset.split('/').any(|segment| segment == "." || segment == "..")
            && asset.bytes().all(|byte| !byte.is_ascii_control() && !matches!(byte, b'?' | b'#' | b'\\'));
        if !safe {
            return None;
        }
        let base = format!("{CDN_ORIGIN}assets/collectibles/{asset}");
        let still = self.asset(&format!("{base}static.png"), "png")?;
        let video = self.asset(&format!("{base}asset.webm"), "webm")?;
        Some(Item::Nameplate(Nameplate {
            id: context.id.into(),
            name: context.name.into(),
            category: context.category.clone(),
            label: text(item, &["label"]),
            still,
            video,
            palette: text(item, &["palette"]).filter(|palette| {
                palette.len() <= 24 && palette.bytes().all(|byte| byte.is_ascii_lowercase() || byte == b'_')
            }),
        }))
    }

    fn effect(&mut self, context: &Context, item: &Value) -> Option<Item> {
        let mut layers = Vec::new();
        for layer in item.get("effects")?.as_array()?.iter().take(16) {
            let Some(src) = text(layer, &["src"]).and_then(|src| self.asset(&src, "png")) else {
                continue;
            };
            let random = layer
                .get("randomizedSources")
                .or_else(|| layer.get("randomized_sources"))
                .and_then(Value::as_array)
                .map(|sources| {
                    sources
                        .iter()
                        .take(16)
                        .filter_map(|source| text(source, &["src"]))
                        .filter_map(|src| self.asset(&src, "png"))
                        .collect()
                })
                .unwrap_or_default();
            let position = layer.get("position").unwrap_or(&Value::Null);
            layers.push(EffectLayer {
                src,
                random,
                repeat: layer.get("loop").and_then(Value::as_bool).unwrap_or(false),
                start: bounded(number(layer, &["start"]), 0, 600_000),
                duration: bounded(number(layer, &["duration"]), 0, 600_000),
                delay: bounded(number(layer, &["loopDelay", "loop_delay"]), 0, 600_000),
                x: number(position, &["x"]).unwrap_or(0).clamp(-4096, 4096) as i32,
                y: number(position, &["y"]).unwrap_or(0).clamp(-4096, 4096) as i32,
                z: number(layer, &["zIndex", "z_index"]).unwrap_or(100).clamp(-1000, 1000) as i32,
                width: bounded(number(layer, &["width"]), EFFECT_WIDTH, 4096).max(1),
                height: bounded(number(layer, &["height"]), EFFECT_HEIGHT, 4096).max(1),
            });
        }
        if layers.is_empty() {
            return None;
        }
        layers.sort_by_key(|layer| layer.z);
        let preview = text(item, &["thumbnailPreviewSrc", "thumbnail_preview_src"])
            .and_then(|src| self.asset(&src, "png"));
        let still = text(item, &["reducedMotionSrc", "reduced_motion_src", "staticFrameSrc", "static_frame_src"])
            .and_then(|src| self.asset(&src, "png"));
        Some(Item::Effect(Effect {
            id: context.id.into(),
            name: context.name.into(),
            category: context.category.clone(),
            label: text(item, &["accessibilityLabel", "accessibility_label", "title"]),
            preview,
            still,
            layers,
        }))
    }

    fn frame(&mut self, context: &Context, item: &Value) -> Option<Item> {
        let mut layers = Vec::new();
        for layer in item.get("layers")?.as_array()?.iter().take(8) {
            let Some(layer_id) = text(layer, &["id"]).filter(|id| is_sku_id(id)) else {
                continue;
            };
            let url = format!("{CDN_ORIGIN}media/v1/collectibles-shop/{}/{layer_id}/static", context.id);
            let Some(src) = self.asset(&url, "png") else {
                continue;
            };
            let kind = text(layer, &["type"]).unwrap_or_else(|| "staple".into());
            let anchor = text(layer, &["anchor"]).unwrap_or_else(|| "top".into());
            layers.push(FrameLayer {
                src,
                kind: if matches!(kind.as_str(), "staple" | "rail" | "border") { kind } else { "staple".into() },
                front: text(layer, &["order"]).as_deref() != Some("back"),
                anchor: if matches!(anchor.as_str(), "top" | "bottom" | "center") { anchor } else { "top".into() },
                responsive: layer.get("responsive").and_then(Value::as_bool).unwrap_or(false),
            });
        }
        if layers.is_empty() {
            return None;
        }
        Some(Item::Frame(Frame {
            id: context.id.into(),
            name: context.name.into(),
            category: context.category.clone(),
            label: text(item, &["label_localized", "label"]),
            color: context.color.clone(),
            inner: bounded(number(item, &["inner_width"]), 1200, 4096).max(1),
            top: bounded(number(item, &["overflow_top"]), 0, 4096),
            bottom: bounded(number(item, &["overflow_bottom"]), 0, 4096),
            side: bounded(number(item, &["overflow_horizontal"]), 0, 4096),
            layers,
        }))
    }

    fn item(&mut self, context: &Context, item: &Value) -> Option<Item> {
        match number(item, &["type"])? {
            0 => self.decoration(context, item),
            1 => self.effect(context, item),
            2 => self.nameplate(context, item),
            3 => self.frame(context, item),
            _ => None,
        }
    }

    fn product(&mut self, product: &Value, category_name: Option<String>) {
        let Some(id) = text(product, &["sku_id", "id"]).filter(|id| is_sku_id(id)) else {
            return;
        };
        let category = text(product, &["category_sku_id"]).filter(|id| is_sku_id(id));
        if let (Some(category), Some(name)) = (&category, category_name) {
            self.categories.insert(category.clone(), name);
        }
        if number(product, &["type"]) == Some(1000) {
            return;
        }
        let Some(name) = text(product, &["name"]) else {
            return;
        };
        let context = Context {
            id: &id,
            name: &name,
            category,
            color: hex_color(product.get("variant_value").and_then(Value::as_str)),
        };
        let item = product.get("items").and_then(Value::as_array).and_then(|items| items.first());
        if let Some(parsed) = item.and_then(|item| self.item(&context, item)) {
            self.items.push(parsed);
        }
    }
}

pub fn parse_export(bytes: &[u8]) -> Result<Parsed, serde_json::Error> {
    let export: Export = serde_json::from_slice(bytes)?;
    let mut parsed = Parsed::default();
    for (id, category) in &export.categories {
        if let Some(name) = category.name.as_deref().map(str::trim).filter(|name| !name.is_empty()) {
            if is_sku_id(id) {
                parsed.categories.insert(id.clone(), name.chars().take(80).collect());
            }
        }
    }
    let mut skus: Vec<(String, ExportSku)> = export.skus.into_iter().collect();
    skus.sort_by(|a, b| a.0.cmp(&b.0));
    for (id, mut sku) in skus {
        sku.sku_id.get_or_insert(id);
        let category_name = sku.category_name.take();
        if let Ok(product) = serde_json::to_value(&sku) {
            parsed.product(&product, category_name);
        }
    }
    Ok(parsed)
}

fn newest_first(a: &str, b: &str) -> std::cmp::Ordering {
    b.len().cmp(&a.len()).then_with(|| b.cmp(a))
}

pub fn build(previous: &Index, sources: Vec<Parsed>, now: u64) -> Index {
    let mut items: BTreeMap<String, Item> = BTreeMap::new();
    for item in previous.catalog.decorations.iter().cloned().map(Item::Decoration)
        .chain(previous.catalog.effects.iter().cloned().map(Item::Effect))
        .chain(previous.catalog.nameplates.iter().cloned().map(Item::Nameplate))
        .chain(previous.catalog.frames.iter().cloned().map(Item::Frame))
    {
        items.insert(item.id().to_owned(), item);
    }
    let mut assets = previous.assets.clone();
    let mut categories: BTreeMap<String, String> = previous
        .catalog
        .categories
        .iter()
        .map(|category| (category.id.clone(), category.name.clone()))
        .collect();
    for source in sources {
        for item in source.items {
            items.insert(item.id().to_owned(), item);
        }
        assets.extend(source.assets);
        categories.extend(source.categories);
    }
    let mut catalog = Catalog::default();
    for item in items.into_values() {
        match item {
            Item::Decoration(item) => catalog.decorations.push(item),
            Item::Effect(item) => catalog.effects.push(item),
            Item::Nameplate(item) => catalog.nameplates.push(item),
            Item::Frame(item) => catalog.frames.push(item),
        }
    }
    catalog.decorations.sort_by(|a, b| newest_first(&a.id, &b.id));
    catalog.effects.sort_by(|a, b| newest_first(&a.id, &b.id));
    catalog.nameplates.sort_by(|a, b| newest_first(&a.id, &b.id));
    catalog.frames.sort_by(|a, b| newest_first(&a.id, &b.id));
    let used: BTreeSet<&String> = catalog
        .decorations
        .iter()
        .map(|item| &item.category)
        .chain(catalog.effects.iter().map(|item| &item.category))
        .chain(catalog.nameplates.iter().map(|item| &item.category))
        .chain(catalog.frames.iter().map(|item| &item.category))
        .flatten()
        .collect();
    catalog.categories = categories
        .into_iter()
        .filter(|(id, _)| used.contains(id))
        .map(|(id, name)| Category { id, name })
        .collect();
    let referenced = referenced_assets(&catalog);
    assets.retain(|key, _| referenced.contains(key));
    catalog.version = catalog_version(&catalog);
    catalog.updated_at = if catalog.version == previous.catalog.version && previous.catalog.updated_at > 0 {
        previous.catalog.updated_at
    } else {
        now
    };
    Index {
        catalog,
        assets,
        source_stamp: previous.source_stamp.clone(),
    }
}

pub fn referenced_names(catalog: &Catalog) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    for item in &catalog.decorations {
        names.insert(item.still.clone());
        names.insert(item.animated.clone());
    }
    for item in &catalog.nameplates {
        names.insert(item.still.clone());
        names.insert(item.video.clone());
    }
    for item in &catalog.effects {
        names.extend(item.preview.iter().cloned());
        names.extend(item.still.iter().cloned());
        for layer in &item.layers {
            names.insert(layer.src.clone());
            names.extend(layer.random.iter().cloned());
        }
    }
    for item in &catalog.frames {
        names.extend(item.layers.iter().map(|layer| layer.src.clone()));
    }
    names
}

fn referenced_assets(catalog: &Catalog) -> BTreeSet<String> {
    referenced_names(catalog)
        .into_iter()
        .filter_map(|name| split_asset_name(&name).map(|(key, _)| key.to_owned()))
        .collect()
}

fn catalog_version(catalog: &Catalog) -> String {
    let mut unversioned = catalog.clone();
    unversioned.version.clear();
    unversioned.updated_at = 0;
    let bytes = serde_json::to_vec(&unversioned).unwrap_or_default();
    hex::encode(&Sha256::digest(&bytes)[..8])
}
