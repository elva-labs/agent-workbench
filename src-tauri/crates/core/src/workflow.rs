//! Workflows: which model a session starts on and which models it hands
//! work and review to.
//!
//! A workflow names the orchestrator's model, the session the user talks to,
//! and steps in order. A step either does work or reviews it, and says which
//! models it may use: none listed means any, otherwise a chosen set whose
//! first entry is the one used unless the orchestrator has a reason to pick
//! another. A model is an agent and a model name, since a model's name
//! belongs to one agent. The roles are fixed: orchestrator, worker, reviewer.
//!
//! The workflows are kept in the settings file. This module holds their
//! shape, the default one, and the rules a set of workflows is checked by.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// The agents a model can belong to.
pub const AGENTS: &[&str] = &["claude-code", "codex"];

/// The name Codex's own default model goes by. Nothing lists Codex's models
/// yet, so it is the one a Codex step can name.
pub const CODEX_DEFAULT: &str = "default";

/// How many workflows the settings may hold, how many steps one may have,
/// how many models a step may list, and how long a name may be.
pub const MOST_WORKFLOWS: usize = 16;
pub const MOST_STEPS: usize = 12;
pub const MOST_MODELS: usize = 16;
pub const LONGEST_NAME: usize = 40;
/// The most sessions a work step lets run at once: the workbench holds a
/// session to eight running at a time.
pub const MOST_PARALLEL: u32 = 8;
/// The most rounds a review may send the work back for.
pub const MOST_ROUNDS: u32 = 10;

/// An agent and the name of one of its models.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Model {
    pub agent: String,
    pub model: String,
}

/// One step of a workflow. An empty `models` allows any model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Step {
    /// Does the task. `parallel` sessions may run at once.
    Work {
        name: String,
        #[serde(default)]
        models: Vec<Model>,
        parallel: u32,
    },
    /// Checks the work. It passes when each condition that is on holds; if
    /// not, the work goes back to the step `back_to` names, at most `limit`
    /// times, and then the user is asked.
    Review {
        name: String,
        #[serde(default)]
        models: Vec<Model>,
        reviewer_approves: bool,
        orchestrator_agrees: bool,
        back_to: String,
        limit: u32,
    },
}

impl Step {
    pub fn name(&self) -> &str {
        match self {
            Step::Work { name, .. } | Step::Review { name, .. } => name,
        }
    }

    pub fn models(&self) -> &[Model] {
        match self {
            Step::Work { models, .. } | Step::Review { models, .. } => models,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Workflow {
    pub name: String,
    pub orchestrator: Model,
    pub steps: Vec<Step>,
}

/// The user's workflows in the order they are shown, the one new sessions
/// start with (none is a choice), and the projects that say otherwise, by
/// path, each naming a workflow or none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Workflows {
    #[serde(default)]
    pub list: Vec<Workflow>,
    #[serde(default)]
    pub default: Option<String>,
    #[serde(default)]
    pub overrides: BTreeMap<String, Option<String>>,
}

pub const DEFAULT_NAME: &str = "Build and review";

fn claude(model: &str) -> Model {
    Model {
        agent: "claude-code".into(),
        model: model.into(),
    }
}

impl Default for Workflows {
    /// A workflow on a fresh install: the orchestrator on Claude's most
    /// capable model, work on Sonnet, and a review on Opus that sends the
    /// work back up to three times and then asks the user.
    fn default() -> Self {
        Self {
            list: vec![Workflow {
                name: DEFAULT_NAME.into(),
                orchestrator: claude("fable"),
                steps: vec![
                    Step::Work {
                        name: "Work".into(),
                        models: vec![claude("sonnet")],
                        parallel: 1,
                    },
                    Step::Review {
                        name: "Review".into(),
                        models: vec![claude("opus")],
                        reviewer_approves: true,
                        orchestrator_agrees: true,
                        back_to: "Work".into(),
                        limit: 3,
                    },
                ],
            }],
            default: Some(DEFAULT_NAME.into()),
            overrides: BTreeMap::new(),
        }
    }
}

fn check_name(what: &str, name: &str) -> Result<(), String> {
    if name.trim().is_empty() || name.chars().count() > LONGEST_NAME {
        return Err(format!(
            "{what} needs a name of a few words, {LONGEST_NAME} characters at most"
        ));
    }
    Ok(())
}

fn check_model(owner: &str, model: &Model) -> Result<(), String> {
    if !AGENTS.contains(&model.agent.as_str()) {
        return Err(format!(
            "{owner} names the agent {:?}, which is one of {}",
            model.agent,
            AGENTS.join(", ")
        ));
    }
    let name = model.model.trim();
    if name.is_empty()
        || name.chars().count() > LONGEST_NAME
        || name.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err(format!(
            "{owner} names a model that is one word, {LONGEST_NAME} characters at most, not {:?}",
            model.model
        ));
    }
    Ok(())
}

fn check_workflow(workflow: &Workflow) -> Result<(), String> {
    let name = &workflow.name;
    check_name("a workflow", name)?;
    check_model(
        &format!("the orchestrator of {name}"),
        &workflow.orchestrator,
    )?;
    if workflow.steps.is_empty() {
        return Err(format!("{name} needs at least one step"));
    }
    if workflow.steps.len() > MOST_STEPS {
        return Err(format!("{name} has {MOST_STEPS} steps at most"));
    }
    for (index, step) in workflow.steps.iter().enumerate() {
        let step_name = step.name();
        check_name(&format!("a step of {name}"), step_name)?;
        let owner = format!("the step {step_name} of {name}");
        if workflow.steps[..index]
            .iter()
            .any(|earlier| earlier.name().eq_ignore_ascii_case(step_name))
        {
            return Err(format!("{name} has two steps called {step_name}"));
        }
        let models = step.models();
        if models.len() > MOST_MODELS {
            return Err(format!("{owner} lists {MOST_MODELS} models at most"));
        }
        for (at, model) in models.iter().enumerate() {
            check_model(&owner, model)?;
            if models[..at].contains(model) {
                return Err(format!("{owner} lists {} twice", model.model));
            }
        }
        match step {
            Step::Work { parallel, .. } => {
                if !(1..=MOST_PARALLEL).contains(parallel) {
                    return Err(format!(
                        "{owner} runs between 1 and {MOST_PARALLEL} sessions at once, not {parallel}"
                    ));
                }
            }
            Step::Review {
                reviewer_approves,
                orchestrator_agrees,
                back_to,
                limit,
                ..
            } => {
                if !reviewer_approves && !orchestrator_agrees {
                    return Err(format!(
                        "{owner} passes the work when the reviewer approves, the orchestrator agrees, or both; one has to be on"
                    ));
                }
                if !workflow.steps[..index]
                    .iter()
                    .any(|earlier| earlier.name() == back_to)
                {
                    return Err(format!(
                        "{owner} goes back to {back_to:?}, which is not a step before it"
                    ));
                }
                if !(1..=MOST_ROUNDS).contains(limit) {
                    return Err(format!(
                        "{owner} goes back between 1 and {MOST_ROUNDS} times, not {limit}"
                    ));
                }
            }
        }
    }
    Ok(())
}

/// Whether a set of workflows will do: every workflow, and every choice
/// naming one that exists. The reason when not.
pub fn check(workflows: &Workflows) -> Result<(), String> {
    if workflows.list.len() > MOST_WORKFLOWS {
        return Err(format!(
            "the settings hold {MOST_WORKFLOWS} workflows at most"
        ));
    }
    for (index, workflow) in workflows.list.iter().enumerate() {
        check_workflow(workflow)?;
        if workflows.list[..index]
            .iter()
            .any(|earlier| earlier.name.eq_ignore_ascii_case(&workflow.name))
        {
            return Err(format!("there are two workflows called {}", workflow.name));
        }
    }
    let named = |choice: &Option<String>| match choice {
        Some(name) if !workflows.list.iter().any(|workflow| &workflow.name == name) => {
            Err(format!(
                "there is no workflow called {name}; the workflows are {}",
                workflows
                    .list
                    .iter()
                    .map(|workflow| workflow.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ))
        }
        _ => Ok(()),
    };
    named(&workflows.default)?;
    for choice in workflows.overrides.values() {
        named(choice)?;
    }
    Ok(())
}

/// The workflows a value holds, or the reason it will not do.
pub fn read(value: &serde_json::Value) -> Result<Workflows, String> {
    if !value.is_object() {
        return Err(
            "workflows is a list of workflows, the default one's name and the projects that say otherwise".into(),
        );
    }
    let workflows: Workflows = serde_json::from_value(value.clone()).map_err(|error| {
        format!(
            "workflows is a list of workflows, the default one's name and the projects that say otherwise: {error}"
        )
    })?;
    check(&workflows)?;
    Ok(workflows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_default_is_a_workflow_that_passes_its_own_rules() {
        let defaults = Workflows::default();
        assert!(check(&defaults).is_ok());
        assert_eq!(defaults.default.as_deref(), Some(DEFAULT_NAME));
        let workflow = &defaults.list[0];
        assert_eq!(workflow.orchestrator, claude("fable"));
        assert_eq!(workflow.steps.len(), 2);
        assert!(matches!(
            &workflow.steps[0],
            Step::Work { models, parallel: 1, .. } if models == &[claude("sonnet")]
        ));
        assert!(matches!(
            &workflow.steps[1],
            Step::Review { models, limit: 3, back_to, .. }
                if models == &[claude("opus")] && back_to == "Work"
        ));
    }

    #[test]
    fn a_workflow_is_stored_as_camel_cased_json() {
        let value = serde_json::to_value(Workflows::default()).unwrap();
        let review = &value["list"][0]["steps"][1];
        assert_eq!(review["kind"], "review");
        assert_eq!(review["reviewerApproves"], true);
        assert_eq!(review["orchestratorAgrees"], true);
        assert_eq!(review["backTo"], "Work");
        assert_eq!(review["limit"], 3);
        assert_eq!(value["list"][0]["steps"][0]["kind"], "work");
        assert_eq!(value["list"][0]["steps"][0]["parallel"], 1);
        assert_eq!(value["list"][0]["orchestrator"]["agent"], "claude-code");
        assert_eq!(read(&value).unwrap(), Workflows::default());
    }

    fn with(change: impl FnOnce(&mut serde_json::Value)) -> Result<Workflows, String> {
        let mut value = serde_json::to_value(Workflows::default()).unwrap();
        change(&mut value);
        read(&value)
    }

    #[test]
    fn a_workflow_needs_a_name_steps_and_models_that_exist() {
        assert!(with(|v| v["list"][0]["name"] = json!("  ")).is_err());
        assert!(with(|v| v["list"][0]["steps"] = json!([]))
            .unwrap_err()
            .contains("at least one step"));
        assert!(with(|v| v["list"][0]["orchestrator"]["agent"] = json!("gpt")).is_err());
        assert!(with(|v| v["list"][0]["orchestrator"]["model"] = json!("")).is_err());
        assert!(with(|v| v["list"][0]["orchestrator"]["model"] = json!("two words")).is_err());
        assert!(with(|v| v["list"][0]["steps"][0]["extra"] = json!(1)).is_err());
        assert!(with(|v| v["list"][0]["steps"][0]["kind"] = json!("plan")).is_err());
    }

    #[test]
    fn names_are_unique_among_steps_and_among_workflows() {
        let error = with(|v| v["list"][0]["steps"][1]["name"] = json!("work")).unwrap_err();
        assert!(error.contains("two steps called"), "{error}");
        let error = with(|v| {
            let copy = v["list"][0].clone();
            v["list"].as_array_mut().unwrap().push(copy);
        })
        .unwrap_err();
        assert!(error.contains("two workflows called"), "{error}");
    }

    #[test]
    fn limits_stay_within_bounds() {
        assert!(with(|v| v["list"][0]["steps"][0]["parallel"] = json!(0)).is_err());
        assert!(with(|v| v["list"][0]["steps"][0]["parallel"] = json!(9)).is_err());
        assert!(with(|v| v["list"][0]["steps"][0]["parallel"] = json!(8)).is_ok());
        assert!(with(|v| v["list"][0]["steps"][1]["limit"] = json!(0)).is_err());
        assert!(with(|v| v["list"][0]["steps"][1]["limit"] = json!(11)).is_err());
        assert!(with(|v| v["list"][0]["steps"][1]["limit"] = json!(10)).is_ok());
        assert!(with(|v| v["list"][0]["steps"][0]["parallel"] = json!(-1)).is_err());
    }

    #[test]
    fn a_review_passes_on_something_and_goes_back_to_an_earlier_step() {
        let error = with(|v| {
            v["list"][0]["steps"][1]["reviewerApproves"] = json!(false);
            v["list"][0]["steps"][1]["orchestratorAgrees"] = json!(false);
        })
        .unwrap_err();
        assert!(error.contains("one has to be on"), "{error}");
        assert!(with(|v| v["list"][0]["steps"][1]["reviewerApproves"] = json!(false)).is_ok());
        let error = with(|v| v["list"][0]["steps"][1]["backTo"] = json!("Nowhere")).unwrap_err();
        assert!(error.contains("not a step before it"), "{error}");
        // A review cannot go back to itself or to a step after it.
        assert!(with(|v| v["list"][0]["steps"][1]["backTo"] = json!("Review")).is_err());
        let error = with(|v| {
            v["list"][0]["steps"].as_array_mut().unwrap().swap(0, 1);
        })
        .unwrap_err();
        assert!(error.contains("not a step before it"), "{error}");
    }

    #[test]
    fn a_step_lists_a_model_once_and_codex_by_its_default() {
        assert!(with(|v| {
            v["list"][0]["steps"][0]["models"] = json!([
                { "agent": "claude-code", "model": "sonnet" },
                { "agent": "codex", "model": CODEX_DEFAULT }
            ]);
        })
        .is_ok());
        assert!(with(|v| {
            v["list"][0]["steps"][0]["models"] = json!([
                { "agent": "claude-code", "model": "sonnet" },
                { "agent": "claude-code", "model": "sonnet" }
            ]);
        })
        .is_err());
        assert!(with(|v| v["list"][0]["steps"][0]["models"] = json!([])).is_ok());
    }

    #[test]
    fn every_choice_names_a_workflow_or_none() {
        let next = with(|v| {
            v["default"] = json!(null);
            v["overrides"] = json!({ "/p": null, "/q": DEFAULT_NAME });
        })
        .unwrap();
        assert_eq!(next.default, None);
        assert_eq!(next.overrides["/p"], None);
        let error = with(|v| v["default"] = json!("Gone")).unwrap_err();
        assert!(error.contains("no workflow called Gone"), "{error}");
        assert!(with(|v| v["overrides"] = json!({ "/p": "Gone" })).is_err());
        assert!(with(|v| *v = json!([])).is_err());
        assert!(read(&json!({ "list": [], "default": null })).is_ok());
    }

    #[test]
    fn the_settings_hold_a_limited_number_of_workflows() {
        let error = with(|v| {
            let many: Vec<_> = (0..=MOST_WORKFLOWS)
                .map(|n| {
                    let mut workflow = v["list"][0].clone();
                    workflow["name"] = json!(format!("w{n}"));
                    workflow
                })
                .collect();
            v["list"] = json!(many);
            v["default"] = json!("w0");
        })
        .unwrap_err();
        assert!(error.contains("at most"), "{error}");
    }
}
