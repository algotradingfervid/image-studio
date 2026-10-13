//! Shot → H3 ref2va prompt in MiniMax's official "Context IR" format: six sections
//! (`subject_definitions`, `summary`, `retention_analysis`, `detailed_description`,
//! `overall_soundscape`, `non_diegetic_music`), `<Subject N>` labels citing `<Picture N>`
//! references, speakers as `<Subject N> (Sx)` and dialogue inside `<d>[English] …</d>`.
use super::{Character, Shot, Story};

pub const MAX_PROMPT_CHARS: usize = 7000;
const DEFAULT_STYLE: &str = "The target video is in a live-action, cinematic style.";
/// Words that make a delivery phrase carry its own speech verb ("… and says quietly").
const SPEECH_VERBS: &[&str] = &[
    "say", "says", "ask", "asks", "answer", "answers", "reply", "replies", "respond", "responds",
    "whisper", "whispers", "shout", "shouts", "yell", "yells", "call", "calls", "mutter", "mutters",
    "murmur", "murmurs", "exclaim", "exclaims", "add", "adds", "tell", "tells", "speak", "speaks",
    "cry", "cries", "snap", "snaps", "announce", "announces",
];

/// `ref_ids` are the character references only (subject 1's, then subject 2's); a
/// continuing shot's first frame is the caller's extra reference, appended last.
#[derive(Debug, Clone)]
pub struct Compiled { pub prompt: String, pub ref_ids: Vec<String> }

fn trim_end_dot(s: &str) -> &str { s.trim().trim_end_matches('.').trim_end() }

/// Ends the text with `.` unless it already ends with `.`, `?` or `!`.
fn terminal(s: &str) -> String {
    let t = s.trim();
    if t.is_empty() || t.ends_with(['.', '?', '!']) { t.to_string() } else { format!("{t}.") }
}

/// "<Picture 1>", "<Picture 1> and <Picture 2>", "<Picture 1>, <Picture 2>, and <Picture 3>".
fn list(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [a] => a.clone(),
        [a, b] => format!("{a} and {b}"),
        [rest @ .., last] => format!("{}, and {last}", rest.join(", ")),
    }
}

fn is_word_char(c: char) -> bool { c.is_alphanumeric() || c == '_' }

/// Replaces whole-word, case-sensitive occurrences of each name with its label, in one
/// pass (longest name first), so a label is never rewritten again.
fn bind(text: &str, names: &[(String, String)]) -> String {
    let mut sorted: Vec<&(String, String)> = names.iter().filter(|(n, _)| !n.is_empty()).collect();
    sorted.sort_by_key(|(n, _)| std::cmp::Reverse(n.len()));
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    'outer: while i < text.len() {
        let prev_ok = text[..i].chars().next_back().is_none_or(|c| !is_word_char(c));
        if prev_ok {
            for (name, label) in &sorted {
                if text[i..].starts_with(name.as_str())
                    && text[i + name.len()..].chars().next().is_none_or(|c| !is_word_char(c))
                {
                    out.push_str(label);
                    i += name.len();
                    continue 'outer;
                }
            }
        }
        let c = text[i..].chars().next().unwrap();
        out.push(c);
        i += c.len_utf8();
    }
    out
}

/// Sentences of `text` (split after `.`, `?` or `!` followed by whitespace).
fn sentences(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut chars = text.trim().chars().peekable();
    while let Some(c) = chars.next() {
        cur.push(c);
        if matches!(c, '.' | '?' | '!') && chars.peek().is_some_and(|n| n.is_whitespace()) {
            out.push(cur.trim().to_string());
            cur.clear();
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_string());
    }
    out
}

/// The setting's first clause as a phrase ("A flat rooftop at night, …" → "a flat rooftop at night").
fn place(setting: &str) -> String {
    let first = setting.trim().split([',', ';', '.']).next().unwrap_or("").trim();
    for art in ["A ", "An ", "The "] {
        if let Some(rest) = first.strip_prefix(art) {
            return format!("{}{rest}", art.to_lowercase());
        }
    }
    first.to_string()
}

/// "35 mm film, warm grain" → "The target video is in a 35 mm film style with warm grain."
fn style_sentence(style: &str) -> String {
    let style = trim_end_dot(style);
    if style.is_empty() {
        return DEFAULT_STYLE.into();
    }
    let (head, rest) = match style.split_once(',') {
        Some((h, r)) => (h.trim(), r.trim()),
        None => (style, ""),
    };
    let lower = head.to_lowercase();
    let article = if ["a ", "an ", "the "].iter().any(|a| lower.starts_with(a)) {
        ""
    } else if lower.starts_with(['a', 'e', 'i', 'o', 'u', '8']) || lower.starts_with("11 ") || lower.starts_with("18 ") {
        "an "
    } else {
        "a "
    };
    let noun = if lower == "style" || lower.ends_with(" style") { "" } else { " style" };
    let with = if rest.is_empty() { String::new() } else { format!(" with {rest}") };
    format!("The target video is in {article}{head}{noun}{with}.")
}

fn has_speech_verb(delivery: &str) -> bool {
    delivery
        .split(|c: char| !c.is_alphanumeric())
        .any(|w| SPEECH_VERBS.contains(&w.to_lowercase().as_str()))
}

/// Compiles one shot. `has_first_frame`: the previous shot's last frame is sent as the
/// last reference image (`<Picture M>`, M = character refs + 1) and the shot starts from it.
pub fn compile_shot(story: &Story, shot: &Shot, cast: &[Character], has_first_frame: bool) -> Result<Compiled, String> {
    // Characters of this shot in cast order (fixed reference numbering).
    let chars: Vec<&Character> = story.cast.iter()
        .filter(|id| shot.characters.contains(id))
        .filter_map(|id| cast.iter().find(|c| &c.id == id))
        .collect();
    let mut ref_ids = Vec::new();
    let mut subjects: Vec<(&Character, String, Vec<String>)> = Vec::new();
    for (k, c) in chars.iter().enumerate() {
        let first = ref_ids.len() + 1;
        ref_ids.extend(c.ref_ids.iter().cloned());
        let tags = (first..=ref_ids.len()).map(|n| format!("<Picture {n}>")).collect();
        subjects.push((c, format!("<Subject {}>", k + 1), tags));
    }
    let frame = has_first_frame.then(|| format!("<Picture {}>", ref_ids.len() + 1));
    let names: Vec<(String, String)> = subjects.iter().map(|(c, l, _)| (c.name.clone(), l.clone())).collect();
    let b = |t: &str| bind(t.trim(), &names);
    let label_of = |id: &str| -> String {
        subjects.iter().find(|(c, _, _)| c.id == id).map(|(_, l, _)| l.clone())
            .or_else(|| cast.iter().find(|c| c.id == id).map(|c| c.name.clone()))
            .unwrap_or_else(|| id.to_string())
    };
    let labels: Vec<String> = subjects.iter().map(|(_, l, _)| l.clone()).collect();
    let who = list(&labels);
    let place = b(&place(&shot.setting));

    let mut defs = vec!["subject_definitions:".to_string()];
    let mut keep = vec!["retention_analysis:".to_string()];
    for (c, label, tags) in &subjects {
        let desc = trim_end_dot(&c.description);
        let desc = if desc.is_empty() { String::new() } else { format!(": {desc}") };
        defs.push(format!("{label} is {}, the person in {}{desc}.", c.name, list(tags)));
        keep.push(format!("{label} (appears in [Shot 1]): fully_preserved - {}'s face, hair, body and clothing from {} are retained.",
            c.name, list(tags)));
    }
    if let Some(f) = &frame {
        defs.push(format!("{f} is the first frame of [Shot 1], the last frame of the previous shot."));
        keep.push(format!("{f} ([Shot 1] first frame): fully_preserved - the shot starts exactly from this frame."));
    }

    let task = if frame.is_some() { "[keyframe completion + reference generation]" } else { "[reference generation]" };
    let of = if who.is_empty() { String::new() } else { format!(" of {who}") };
    let at = if place.is_empty() { String::new() } else { format!(" in {place}") };
    let summary = format!("summary:\n{task} The target video is a single continuous shot{of}{at}.");

    // Body: frame anchor, camera, setting, action sentence 1, dialogue, the rest of the
    // action, the closing sentence (after dialogue) and the scoping sentence.
    let mut body: Vec<String> = Vec::new();
    if let Some(f) = &frame {
        body.push(format!("The shot begins from {f}."));
    }
    for t in [&shot.camera, &shot.setting] {
        if !t.trim().is_empty() {
            body.push(terminal(&b(t)));
        }
    }
    let action: Vec<String> = sentences(&b(&shot.action)).iter().map(|s| terminal(s)).collect();
    body.extend(action.iter().take(1).cloned());
    let mut speakers: Vec<&str> = Vec::new();
    for d in &shot.dialogue {
        let first_line = !speakers.contains(&d.speaker.as_str());
        if first_line {
            speakers.push(&d.speaker);
        }
        let x = speakers.iter().position(|s| *s == d.speaker).unwrap() + 1;
        let mut s = format!("{} (S{x})", label_of(&d.speaker));
        let voice = story.voices.iter().find(|v| v.character_id == d.speaker)
            .map(|v| v.voice.trim().trim_end_matches([',', '.', ';', ':']).trim().to_string())
            .filter(|v| first_line && !v.is_empty());
        if let Some(v) = &voice {
            s.push_str(&format!(", in {v}"));
        }
        let delivery = b(&d.delivery).trim_end_matches([',', '.', ';', ':']).trim().to_string();
        if delivery.is_empty() {
            s.push_str(if voice.is_some() { ", says:" } else { " says:" });
        } else if has_speech_verb(&delivery) {
            s.push_str(&format!(", {delivery}:"));
        } else {
            s.push_str(&format!(", {delivery}, says:"));
        }
        s.push_str(&format!(" <d>[English] {}</d>", terminal(&d.line)));
        body.push(s);
    }
    body.extend(action.iter().skip(1).cloned());
    if let Some(last) = shot.dialogue.last() {
        body.push(format!("{} finishes the line and closes their lips; nobody speaks for the rest of the shot.", label_of(&last.speaker)));
    }
    match labels.len() {
        0 => {}
        1 => body.push(format!("Only {who} appears in the shot.")),
        _ => body.push(format!("Only {who} appear in the shot.")),
    }
    let detail = format!("detailed_description:\n{}\n[Shot 1] {}", style_sentence(&story.style), body.join(" "));

    let sound = if shot.sound.trim().is_empty() {
        let of = if place.is_empty() { "the scene".to_string() } else { place.clone() };
        format!("Natural ambient sound of {of}, with soft footsteps and clothing movement.")
    } else {
        terminal(&b(&shot.sound))
    };
    let prompt = [
        defs.join("\n"),
        summary,
        keep.join("\n"),
        detail,
        format!("overall_soundscape:\n{sound}"),
        "non_diegetic_music:\nN/A".to_string(),
    ]
    .join("\n\n");
    if prompt.chars().count() > MAX_PROMPT_CHARS {
        return Err(format!("Shot {} compiles to {} characters; H3 takes at most 7,000", shot.position, prompt.chars().count()));
    }
    Ok(Compiled { prompt, ref_ids })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stories::{DialogueLine, Voice};

    fn ch(id: &str, name: &str) -> Character {
        Character {
            id: id.into(), name: name.into(), description: "a tall adult".into(), source: "generated".into(),
            consent: true, adult: true, ref_ids: vec![format!("{id}-ref")], ref_paths: vec![], created_at: String::new(), updated_at: String::new(),
        }
    }
    fn story(target_s: u32, cast: &[&str]) -> Story {
        Story {
            id: "s1".into(), title: "T".into(), logline: String::new(), brief: "two adults on a roof".into(), target_s,
            aspect: "16:9".into(), style: String::new(), cast: cast.iter().map(|c| c.to_string()).collect(),
            voices: vec![], status: "draft".into(), result_image_id: None, created_at: String::new(), updated_at: String::new(),
        }
    }
    fn shot(id: &str, position: u32, duration_s: u32, characters: &[&str], continuity: &str) -> Shot {
        Shot {
            id: id.into(), story_id: "s1".into(), position, duration_s,
            characters: characters.iter().map(|c| c.to_string()).collect(),
            setting: "roof".into(), camera: "wide".into(), action: "walks".into(), dialogue: vec![],
            sound: String::new(), continuity: continuity.into(), approved_take_id: None,
        }
    }
    fn line(speaker: &str, delivery: &str, line: &str) -> DialogueLine {
        DialogueLine { speaker: speaker.into(), line: line.into(), delivery: delivery.into() }
    }
    fn voice(id: &str, v: &str) -> Voice { Voice { character_id: id.into(), voice: v.into() } }

    /// The research §3a example: Mara (2 refs) and Ivo (1 ref), 10 s, two lines.
    fn rooftop() -> (Story, Shot, Vec<Character>) {
        let mut mara = ch("c1", "Mara");
        mara.description = "woman in her 30s, short black hair, green bomber jacket".into();
        mara.ref_ids = vec!["m1".into(), "m2".into()];
        let mut ivo = ch("c2", "Ivo");
        ivo.description = "man in his 40s, grey beard, dark wool coat".into();
        ivo.ref_ids = vec!["i1".into()];
        let st = Story {
            style: "35 mm film, warm grain".into(),
            voices: vec![voice("c1", "a low, steady female voice with a calm pace"),
                         voice("c2", "a deep, slightly hoarse male voice with a slow pace")],
            ..story(10, &["c1", "c2"])
        };
        let sh = Shot {
            characters: vec!["c2".into(), "c1".into()],
            setting: "A flat rooftop at night, wet concrete shining under a single sodium lamp, a rusted water tank behind them and the city's lights spread out below in a light drizzle.".into(),
            camera: "A medium two-shot frames Mara on the left and Ivo on the right at the rooftop's edge; the camera pushes in with small amplitude at slow speed.".into(),
            action: "Mara stands with her hands in her jacket pockets, watching the street below, while Ivo leans on the low parapet beside her, rolling an unlit cigarette between his fingers. He pockets the cigarette as Mara nods once and looks back out over the city. Both hold still in the drizzle as the camera completes its push-in.".into(),
            dialogue: vec![
                line("c1", "turns her head toward Ivo and says quietly", "We leave tonight."),
                line("c2", "stops rolling the cigarette, straightens up and answers with a tired half-smile", "Then I'd better pack light."),
            ],
            sound: "Light rain patters on the wet concrete and the metal water tank while distant city traffic hums far below. Fabric rustles softly as the two shift their weight, and the sodium lamp buzzes faintly overhead.".into(),
            ..shot("a", 1, 10, &[], "cut")
        };
        (st, sh, vec![mara, ivo])
    }

    const GOLDEN: &str = "subject_definitions:
<Subject 1> is Mara, the person in <Picture 1> and <Picture 2>: woman in her 30s, short black hair, green bomber jacket.
<Subject 2> is Ivo, the person in <Picture 3>: man in his 40s, grey beard, dark wool coat.

summary:
[reference generation] The target video is a single continuous shot of <Subject 1> and <Subject 2> in a flat rooftop at night.

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - Mara's face, hair, body and clothing from <Picture 1> and <Picture 2> are retained.
<Subject 2> (appears in [Shot 1]): fully_preserved - Ivo's face, hair, body and clothing from <Picture 3> are retained.

detailed_description:
The target video is in a 35 mm film style with warm grain.
[Shot 1] A medium two-shot frames <Subject 1> on the left and <Subject 2> on the right at the rooftop's edge; the camera pushes in with small amplitude at slow speed. A flat rooftop at night, wet concrete shining under a single sodium lamp, a rusted water tank behind them and the city's lights spread out below in a light drizzle. <Subject 1> stands with her hands in her jacket pockets, watching the street below, while <Subject 2> leans on the low parapet beside her, rolling an unlit cigarette between his fingers. <Subject 1> (S1), in a low, steady female voice with a calm pace, turns her head toward <Subject 2> and says quietly: <d>[English] We leave tonight.</d> <Subject 2> (S2), in a deep, slightly hoarse male voice with a slow pace, stops rolling the cigarette, straightens up and answers with a tired half-smile: <d>[English] Then I'd better pack light.</d> He pockets the cigarette as <Subject 1> nods once and looks back out over the city. Both hold still in the drizzle as the camera completes its push-in. <Subject 2> finishes the line and closes their lips; nobody speaks for the rest of the shot. Only <Subject 1> and <Subject 2> appear in the shot.

overall_soundscape:
Light rain patters on the wet concrete and the metal water tank while distant city traffic hums far below. Fabric rustles softly as the two shift their weight, and the sodium lamp buzzes faintly overhead.

non_diegetic_music:
N/A";

    #[test]
    fn golden_two_character_shot_in_official_format() {
        let (st, sh, cast) = rooftop();
        let c = compile_shot(&st, &sh, &cast, false).unwrap();
        assert_eq!(c.ref_ids, vec!["m1", "m2", "i1"]); // cast order, not shot order
        assert_eq!(c.prompt, GOLDEN);
    }

    #[test]
    fn names_are_bound_outside_dialogue_only() {
        let (st, mut sh, cast) = rooftop();
        sh.dialogue = vec![line("c1", "looks at Ivo", "Ivo, Mara is ready. Ivory?")];
        sh.sound = "Ivo's boots scrape; Marathon music far off.".into();
        let p = compile_shot(&st, &sh, &cast, false).unwrap().prompt;
        assert!(p.contains("<Subject 1> (S1), in a low, steady female voice with a calm pace, looks at <Subject 2>, says: <d>[English] Ivo, Mara is ready. Ivory?</d>"), "{p}");
        assert!(p.contains("<Subject 2>'s boots scrape; Marathon music far off."), "{p}");
    }

    #[test]
    fn speaker_ids_follow_first_speech_and_voice_only_on_first_line() {
        let (st, mut sh, cast) = rooftop();
        sh.dialogue = vec![
            line("c2", "", "First."),
            line("c1", "", "Second."),
            line("c2", "", "Third."),
        ];
        let p = compile_shot(&st, &sh, &cast, false).unwrap().prompt;
        assert!(p.contains("<Subject 2> (S1), in a deep, slightly hoarse male voice with a slow pace, says: <d>[English] First.</d>"), "{p}");
        assert!(p.contains("<Subject 1> (S2), in a low, steady female voice with a calm pace, says: <d>[English] Second.</d>"), "{p}");
        assert!(p.contains("</d> <Subject 2> (S1) says: <d>[English] Third.</d>"), "{p}");
        assert_eq!(p.matches("hoarse").count(), 1);
    }

    #[test]
    fn missing_voice_omits_phrase_and_plain_delivery_gets_says() {
        let (mut st, mut sh, cast) = rooftop();
        st.voices.clear();
        sh.dialogue = vec![line("c1", "with a smile", "Hi")];
        let p = compile_shot(&st, &sh, &cast, false).unwrap().prompt;
        assert!(p.contains("<Subject 1> (S1), with a smile, says: <d>[English] Hi.</d>"), "{p}");
    }

    #[test]
    fn terminal_punctuation_is_forced() {
        let (st, mut sh, cast) = rooftop();
        sh.dialogue = vec![line("c1", "", "Wait"), line("c2", "", "Why?"), line("c1", "", "Now!")];
        let p = compile_shot(&st, &sh, &cast, false).unwrap().prompt;
        assert!(p.contains("<d>[English] Wait.</d>"));
        assert!(p.contains("<d>[English] Why?</d>"));
        assert!(p.contains("<d>[English] Now!</d>"));
    }

    #[test]
    fn continues_shot_anchors_on_the_extra_last_picture() {
        let (st, sh, cast) = rooftop();
        let c = compile_shot(&st, &sh, &cast, true).unwrap();
        assert_eq!(c.ref_ids, vec!["m1", "m2", "i1"], "the frame is appended by the caller");
        let p = c.prompt;
        assert!(p.contains("green bomber jacket.\n<Subject 2> is Ivo, the person in <Picture 3>: man in his 40s, grey beard, dark wool coat.\n<Picture 4> is the first frame of [Shot 1], the last frame of the previous shot.\n\nsummary:"), "{p}");
        assert!(p.contains("summary:\n[keyframe completion + reference generation] The target video"), "{p}");
        assert!(p.contains("are retained.\n<Picture 4> ([Shot 1] first frame): fully_preserved - the shot starts exactly from this frame.\n\ndetailed_description:"), "{p}");
        assert!(p.contains("[Shot 1] The shot begins from <Picture 4>. A medium two-shot"), "{p}");
    }

    #[test]
    fn no_dialogue_no_closing_sentence_and_one_character_scope() {
        let (st, mut sh, cast) = rooftop();
        sh.dialogue.clear();
        sh.characters = vec!["c1".into()];
        let c = compile_shot(&st, &sh, &cast, false).unwrap();
        assert_eq!(c.ref_ids, vec!["m1", "m2"]);
        assert!(!c.prompt.contains("closes their lips"));
        assert!(!c.prompt.contains("<d>"));
        assert!(c.prompt.contains("of <Subject 1> in a flat rooftop at night."), "{}", c.prompt);
        assert!(c.prompt.ends_with("Only <Subject 1> appears in the shot.\n\noverall_soundscape:\nLight rain patters on the wet concrete and the metal water tank while distant city traffic hums far below. Fabric rustles softly as the two shift their weight, and the sodium lamp buzzes faintly overhead.\n\nnon_diegetic_music:\nN/A"), "{}", c.prompt);
        // Ivo is not in this shot: his name stays a name.
        assert!(c.prompt.contains("while Ivo leans"), "{}", c.prompt);
    }

    #[test]
    fn empty_sound_and_style_use_fallbacks() {
        let mut sh = shot("a", 1, 8, &["c1"], "cut");
        sh.setting = "The kitchen of a small flat, morning light".into();
        let c = compile_shot(&story(8, &["c1"]), &sh, &[ch("c1", "Mara")], false).unwrap();
        assert!(c.prompt.contains("overall_soundscape:\nNatural ambient sound of the kitchen of a small flat, with soft footsteps and clothing movement.\n"), "{}", c.prompt);
        assert!(c.prompt.contains("detailed_description:\nThe target video is in a live-action, cinematic style.\n[Shot 1] wide. The kitchen of a small flat, morning light. walks. Only <Subject 1> appears in the shot."), "{}", c.prompt);
        assert!(c.prompt.contains("<Subject 1> is Mara, the person in <Picture 1>: a tall adult.\n"), "{}", c.prompt);
    }

    #[test]
    fn style_sentences() {
        assert_eq!(style_sentence("anime"), "The target video is in an anime style.");
        assert_eq!(style_sentence("noir style, hard shadows."), "The target video is in a noir style with hard shadows.");
        assert_eq!(style_sentence("35 mm film, warm grain, handheld"), "The target video is in a 35 mm film style with warm grain, handheld.");
        assert_eq!(style_sentence("  "), DEFAULT_STYLE);
    }

    #[test]
    fn three_pictures_use_a_serial_list() {
        let mut m = ch("c1", "Mara");
        m.ref_ids = vec!["a".into(), "b".into(), "c".into()];
        let c = compile_shot(&story(8, &["c1"]), &shot("a", 1, 8, &["c1"], "cut"), &[m], false).unwrap();
        assert!(c.prompt.contains("the person in <Picture 1>, <Picture 2>, and <Picture 3>: a tall adult."), "{}", c.prompt);
    }

    #[test]
    fn long_prompt_errors() {
        let mut s = shot("a", 1, 8, &["c1"], "cut");
        s.action = "x".repeat(8000);
        assert!(compile_shot(&story(8, &["c1"]), &s, &[ch("c1", "Mara")], false).unwrap_err().contains("7,000"));
    }
}
