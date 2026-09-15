//! The sources of plugins the workbench offers from the first launch.
//!
//! The list ships with the app, in a file at the repository root that is
//! compiled in. It names each source's repository and ref, and the name
//! and one line of each plugin that source's manifest declares, so the
//! settings can offer a plugin before anything has been fetched. The
//! manifest is the truth once the source is there; the list is what the
//! app says until then.

/// A plugin a known source declares, as the list names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnownPlugin {
    pub name: String,
    pub description: String,
}

/// A source the app offers out of the box.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnownSource {
    /// The last part of the source's stored id, which is fixed.
    pub id: String,
    pub repository: String,
    pub reference: Option<String>,
    pub plugins: Vec<KnownPlugin>,
}

/// The shipped list, as the app reads it.
const LIST: &str = include_str!("../../../../known-plugins.toml");

/// The prefix a known source's stored id carries, so the id of a source
/// the list names is the same on every install.
pub const PREFIX: &str = "known-";

/// The stored id of the known source named `id`.
pub fn stored_id(id: &str) -> String {
    format!("{PREFIX}{id}")
}

/// The known source the stored id names, when it names one.
pub fn suffix(stored: &str) -> Option<&str> {
    stored.strip_prefix(PREFIX)
}

/// The sources the app offers. A list that will not parse offers none,
/// which the test below is what keeps from shipping.
pub fn known() -> Vec<KnownSource> {
    known_from(LIST).unwrap_or_default()
}

/// The sources a list names. The text is a parameter so a test can hand
/// the plugins a list of its own.
pub fn known_from(text: &str) -> Result<Vec<KnownSource>, String> {
    let document = text
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| format!("the known list is invalid: {e}"))?;
    let entries = document
        .get("source")
        .and_then(|item| item.as_array_of_tables())
        .ok_or("the known list has no [[source]] entries")?;
    let mut sources: Vec<KnownSource> = Vec::new();
    for table in entries.iter() {
        let string = |key: &str| -> Result<String, String> {
            table
                .get(key)
                .and_then(|item| item.as_str())
                .map(str::to_string)
                .ok_or_else(|| format!("a source has no {key}"))
        };
        let id = string("id")?;
        let repository = string("repository")?;
        let reference = table
            .get("ref")
            .and_then(|item| item.as_str())
            .map(str::to_string);
        let mut plugins = Vec::new();
        let listed = table
            .get("plugin")
            .and_then(|item| item.as_array_of_tables())
            .ok_or_else(|| format!("the source {id} names no plugins"))?;
        for plugin in listed.iter() {
            let field = |key: &str| -> Result<String, String> {
                plugin
                    .get(key)
                    .and_then(|item| item.as_str())
                    .map(str::to_string)
                    .ok_or_else(|| format!("a plugin of {id} has no {key}"))
            };
            plugins.push(KnownPlugin {
                name: field("name")?,
                description: field("description")?,
            });
        }
        sources.push(KnownSource {
            id,
            repository,
            reference,
            plugins,
        });
    }
    Ok(sources)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::valid_name;
    use std::collections::HashSet;

    /// The shipped list is what the settings offer on a fresh install, so
    /// an edit that breaks it is caught here rather than there.
    #[test]
    fn the_shipped_list_names_sources_the_app_can_use() {
        let sources = known_from(LIST).expect("the shipped list parses");
        assert!(!sources.is_empty(), "the list names no sources");
        let mut ids = HashSet::new();
        for source in &sources {
            assert!(
                valid_name(&source.id),
                "the id {:?} is not a name",
                source.id
            );
            assert!(
                ids.insert(source.id.clone()),
                "the id {:?} is used twice",
                source.id
            );
            assert!(
                !source.repository.trim().is_empty(),
                "the source {} has no repository",
                source.id
            );
            if let Some(reference) = &source.reference {
                assert!(
                    !reference.trim().is_empty(),
                    "the source {} has an empty ref",
                    source.id
                );
            }
            assert!(
                !source.plugins.is_empty(),
                "the source {} names no plugins",
                source.id
            );
            let mut names = HashSet::new();
            for plugin in &source.plugins {
                assert!(
                    valid_name(&plugin.name),
                    "the plugin name {:?} is not a name",
                    plugin.name
                );
                assert!(
                    names.insert(plugin.name.clone()),
                    "the source {} names {:?} twice",
                    source.id,
                    plugin.name
                );
                assert!(
                    !plugin.description.trim().is_empty(),
                    "the plugin {} of {} has no description",
                    plugin.name,
                    source.id
                );
            }
        }
    }

    #[test]
    fn a_list_that_is_missing_something_is_refused() {
        assert!(known_from("nonsense =").is_err());
        assert!(known_from("[[source]]\nid = \"a\"\n").is_err());
        assert!(known_from("[[source]]\nid = \"a\"\nrepository = \"u\"\n").is_err());
        let without =
            "[[source]]\nid = \"a\"\nrepository = \"u\"\n[[source.plugin]]\nname = \"p\"\n";
        assert!(known_from(without).is_err());
        let whole = "[[source]]\nid = \"a\"\nrepository = \"u\"\nref = \"main\"\n[[source.plugin]]\nname = \"p\"\ndescription = \"d\"\n";
        let sources = known_from(whole).unwrap();
        assert_eq!(sources[0].reference.as_deref(), Some("main"));
        assert_eq!(sources[0].plugins[0].name, "p");
        assert_eq!(stored_id("a"), "known-a");
        assert_eq!(suffix("known-a"), Some("a"));
        assert_eq!(suffix("src-1"), None);
    }
}
