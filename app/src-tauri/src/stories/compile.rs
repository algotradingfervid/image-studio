use super::{Character, Shot, Story};

pub const MAX_PROMPT_CHARS: usize = 7000;

#[derive(Debug, Clone)]
pub struct Compiled { pub prompt: String, pub ref_ids: Vec<String> }

fn trim_end_dot(s: &str) -> &str { s.trim().trim_end_matches('.') }

pub fn compile_shot(story: &Story, shot: &Shot, cast: &[Character]) -> Result<Compiled, String> {
    // Characters of this shot in cast order (fixed numbering across shots).
    let chars: Vec<&Character> = story.cast.iter()
        .filter(|id| shot.characters.contains(id))
        .filter_map(|id| cast.iter().find(|c| &c.id == id))
        .collect();
    let mut lines = vec!["ROLES:".to_string()];
    let mut ref_ids = Vec::new();
    for c in &chars {
        let first = ref_ids.len() + 1;
        ref_ids.extend(c.ref_ids.iter().cloned());
        let tags: Vec<String> = (first..=ref_ids.len()).map(|n| format!("<Picture {n}>")).collect();
        let (verb, these) = if tags.len() == 1 { ("is", "this picture") } else { ("are", "these pictures") };
        lines.push(format!("{} {verb} {}: {}. Keep {}'s face, hair, body and clothing identical to {these}.",
            tags.join(", "), c.name, trim_end_dot(&c.description), c.name));
    }
    let name = |id: &str| -> String { cast.iter().find(|c| c.id == id).map(|c| c.name.clone()).unwrap_or_else(|| id.to_string()) };
    lines.push(format!("SHOT ({} s, {}, {}): {}.", shot.duration_s, story.aspect, shot.camera.trim(), trim_end_dot(&shot.setting)));
    lines.push(shot.action.trim().to_string());
    for d in &shot.dialogue {
        lines.push(format!("{} says: \"{}\"", name(&d.speaker), d.line.trim()));
    }
    let look = if story.style.trim().is_empty() { "natural cinematic look" } else { trim_end_dot(&story.style) };
    lines.push(format!("LOOK: {look}."));
    lines.push("SOUND: natural ambient sound of the setting. Dialogue is spoken aloud and lip-synced to the speaker.".into());
    lines.push("LIMITS: Hold identity and clothing from the pictures. No subtitles, no on-screen text, no watermark, no extra people, no face morphing.".into());
    let prompt = lines.join("\n");
    if prompt.chars().count() > MAX_PROMPT_CHARS {
        return Err(format!("Shot {} compiles to {} characters; H3 takes at most 7,000", shot.position, prompt.chars().count()));
    }
    Ok(Compiled { prompt, ref_ids })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stories::DialogueLine;

    fn ch(id: &str, name: &str) -> Character {
        Character {
            id: id.into(), name: name.into(), description: "a tall adult".into(), source: "generated".into(),
            consent: true, adult: true, ref_ids: vec![format!("{id}-ref")], created_at: String::new(), updated_at: String::new(),
        }
    }
    fn story(target_s: u32, cast: &[&str]) -> Story {
        Story {
            id: "s1".into(), title: "T".into(), logline: String::new(), brief: "two adults on a roof".into(), target_s,
            aspect: "16:9".into(), style: String::new(), cast: cast.iter().map(|c| c.to_string()).collect(),
            status: "draft".into(), result_image_id: None, created_at: String::new(), updated_at: String::new(),
        }
    }
    fn shot(id: &str, position: u32, duration_s: u32, characters: &[&str], continuity: &str) -> Shot {
        Shot {
            id: id.into(), story_id: "s1".into(), position, duration_s,
            characters: characters.iter().map(|c| c.to_string()).collect(),
            setting: "roof".into(), camera: "wide".into(), action: "walks".into(), dialogue: vec![],
            continuity: continuity.into(), approved_take_id: None,
        }
    }

#[test]
fn compiles_two_character_shot_in_fixed_reference_order() {
    let mut mara = ch("c1", "Mara"); mara.description = "woman in her 30s, short black hair, green bomber jacket".into();
    mara.ref_ids = vec!["m1".into(), "m2".into()];
    let mut ivo = ch("c2", "Ivo"); ivo.description = "man in his 40s, grey beard".into(); ivo.ref_ids = vec!["i1".into()];
    let st = Story { style: "35 mm film, warm grain".into(), aspect: "16:9".into(), cast: vec!["c1".into(), "c2".into()], ..story(10, &[]) };
    let sh = Shot { duration_s: 10, characters: vec!["c2".into(), "c1".into()], setting: "rooftop at night".into(),
        camera: "medium shot, slow push-in".into(), action: "Mara turns to Ivo.".into(),
        dialogue: vec![DialogueLine { speaker: "c1".into(), line: "We leave tonight.".into() }], ..shot("a", 1, 10, &[], "cut") };
    let c = compile_shot(&st, &sh, &[mara, ivo]).unwrap();
    assert_eq!(c.ref_ids, vec!["m1", "m2", "i1"]); // cast order, not shot order
    assert_eq!(c.prompt, "ROLES:\n\
<Picture 1>, <Picture 2> are Mara: woman in her 30s, short black hair, green bomber jacket. Keep Mara's face, hair, body and clothing identical to these pictures.\n\
<Picture 3> is Ivo: man in his 40s, grey beard. Keep Ivo's face, hair, body and clothing identical to this picture.\n\
SHOT (10 s, 16:9, medium shot, slow push-in): rooftop at night.\n\
Mara turns to Ivo.\n\
Mara says: \"We leave tonight.\"\n\
LOOK: 35 mm film, warm grain.\n\
SOUND: natural ambient sound of the setting. Dialogue is spoken aloud and lip-synced to the speaker.\n\
LIMITS: Hold identity and clothing from the pictures. No subtitles, no on-screen text, no watermark, no extra people, no face morphing.");
}
#[test] fn no_style_uses_default_look_and_long_prompt_errors() {
    let c = compile_shot(&story(8, &["c1"]), &shot("a", 1, 8, &["c1"], "cut"), &[ch("c1", "Mara")]).unwrap();
    assert!(c.prompt.contains("LOOK: natural cinematic look."));
    let mut s = shot("a", 1, 8, &["c1"], "cut"); s.action = "x".repeat(8000);
    assert!(compile_shot(&story(8, &["c1"]), &s, &[ch("c1", "Mara")]).unwrap_err().contains("7,000"));
}
}
