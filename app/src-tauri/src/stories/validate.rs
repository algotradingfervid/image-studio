use super::{Character, Issue, Shot, Story};

pub const MIN_SHOT_S: u32 = 5;
pub const MAX_SHOT_S: u32 = 15;
pub const MAX_CAST_PER_SHOT: usize = 2;
pub const WORDS_PER_S: f64 = 2.5;
pub const TOTAL_TOLERANCE: f64 = 0.15;
pub const MAX_REFS_PER_SHOT: usize = 6;
pub const MAX_DELIVERY_WORDS: usize = 15;
const DOUBLE_QUOTES: &[char] = &['"', '\u{201C}', '\u{201D}'];

const MINOR_TERMS: &[&str] = &[
    "child", "children", "kid", "kids", "teen", "teens", "teenage", "teenager", "teenagers",
    "schoolgirl", "schoolgirls", "schoolboy", "schoolboys", "underage", "preteen", "preteens",
    "toddler", "toddlers", "infant", "infants", "loli", "shota",
];

const VOICE_MINOR_TERMS: &[&str] = &[
    "girl", "girls", "boy", "boys", "girlish", "boyish", "childlike", "childish",
];

const NUMBER_WORDS: &[&str] = &[
    "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven",
    "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
];

fn words(text: &str) -> Vec<String> {
    text.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(String::from).collect()
}

/// An age under 18 written as digits or as a number word (one..seventeen).
fn minor_age(token: &str) -> bool {
    token.parse::<u32>().map(|n| n < 18).unwrap_or_else(|_| NUMBER_WORDS.contains(&token))
}

/// True when `text` describes someone under 18: a term from the list, or an explicit age phrase
/// ("N year(s) old", "N-year-old", "N yr(s) old", "N yo", "Nyo") with N under 18 in digits or words.
pub fn mentions_minor(text: &str) -> bool {
    let w = words(text);
    if w.iter().any(|x| MINOR_TERMS.contains(&x.as_str())) {
        return true;
    }
    if w.iter().any(|x| x.strip_suffix("yo").is_some_and(|n| !n.is_empty() && minor_age(n))) {
        return true;
    }
    w.windows(3).any(|p| {
        minor_age(&p[0]) && matches!(p[1].as_str(), "year" | "years" | "yr" | "yrs") && p[2] == "old"
    }) || w.windows(2).any(|p| minor_age(&p[0]) && p[1] == "yo")
}

/// Story-level checks that must pass before planning or rendering: a brief,
/// a cast, adults only, consent for real people, no minors in the brief, style
/// or character descriptions.
pub fn preflight(story: &Story, cast: &[Character]) -> Vec<Issue> {
    let mut out = Vec::new();
    let story_issue = |out: &mut Vec<Issue>, m: String| out.push(Issue { shot: None, message: m });
    if story.brief.trim().is_empty() {
        story_issue(&mut out, "Write a brief first".into());
    }
    if story.cast.is_empty() || cast.is_empty() {
        story_issue(&mut out, "Add at least one character to the cast first".into());
    }
    for c in cast {
        if !c.adult {
            story_issue(&mut out, format!("{} is not confirmed as an adult (18+)", c.name));
        }
        if c.source == "real_person" && !c.consent {
            story_issue(&mut out, format!("{} is a real person without a consent tick", c.name));
        }
        if mentions_minor(&c.description) {
            story_issue(&mut out, format!("{}'s description must describe an adult; stories use adults only", c.name));
        }
    }
    if mentions_minor(&story.brief) || mentions_minor(&story.style) {
        story_issue(&mut out, "The brief must describe adults only".into());
    }
    for v in &story.voices {
        let name = cast.iter().find(|c| c.id == v.character_id).map(|c| c.name.as_str()).unwrap_or(&v.character_id);
        if voice_mentions_minor(&v.voice) {
            story_issue(&mut out, format!("{name}'s voice must describe an adult; stories use adults only"));
        }
        if v.voice.contains(DOUBLE_QUOTES) {
            story_issue(&mut out, format!("{name}'s voice has double quotes; remove them"));
        }
    }
    out
}

/// Voice phrases also refuse "girl"/"boy" words ("a young girl's voice"), which other
/// fields allow ("girls' night out").
fn voice_mentions_minor(voice: &str) -> bool {
    mentions_minor(voice) || words(voice).iter().any(|w| VOICE_MINOR_TERMS.contains(&w.as_str()))
}

/// `preflight` plus the shot rules.
pub fn validate(story: &Story, shots: &[Shot], cast: &[Character]) -> Vec<Issue> {
    let mut out = preflight(story, cast);
    let name = |id: &str| cast.iter().find(|c| c.id == id).map(|c| c.name.clone()).unwrap_or_else(|| id.to_string());
    let story_issue = |out: &mut Vec<Issue>, m: String| out.push(Issue { shot: None, message: m });
    if shots.is_empty() {
        story_issue(&mut out, "The story has no shots".into());
        return out;
    }
    let total: u32 = shots.iter().map(|s| s.duration_s).sum();
    let (lo, hi) = (story.target_s as f64 * (1.0 - TOTAL_TOLERANCE), story.target_s as f64 * (1.0 + TOTAL_TOLERANCE));
    if (total as f64) < lo || (total as f64) > hi {
        story_issue(&mut out, format!("Shots add up to {total} s; the target is {} s (±15 %)", story.target_s));
    }
    for (i, s) in shots.iter().enumerate() {
        let n = Some(s.position);
        let mut push = |m: String| out.push(Issue { shot: n, message: m });
        if !(MIN_SHOT_S..=MAX_SHOT_S).contains(&s.duration_s) {
            push(format!("Duration {} s is outside 5–15 s", s.duration_s));
        }
        if s.characters.is_empty() {
            push(format!("Shot {} needs at least one character", s.position));
        }
        if s.characters.len() > MAX_CAST_PER_SHOT {
            push(format!("{} characters; at most 2 per shot", s.characters.len()));
        }
        for c in &s.characters {
            if !story.cast.contains(c) {
                push(format!("{} is not in the cast", name(c)));
            }
        }
        let words_total: usize = s.dialogue.iter().map(|d| words(&d.line).len()).sum();
        let max_words = (WORDS_PER_S * s.duration_s as f64).floor() as usize;
        if words_total > max_words {
            push(format!("Dialogue has {words_total} words; at most {max_words} fit in {} s", s.duration_s));
        }
        for d in &s.dialogue {
            if !s.characters.contains(&d.speaker) {
                push(format!("{} speaks but is not in this shot", name(&d.speaker)));
            }
            if d.line.contains(DOUBLE_QUOTES) {
                push(format!("{}'s line has double quotes; write the words without quotation marks", name(&d.speaker)));
            }
            if d.delivery.contains(DOUBLE_QUOTES) {
                push(format!("{}'s delivery has double quotes; remove them", name(&d.speaker)));
            }
            let n = words(&d.delivery).len();
            if n > MAX_DELIVERY_WORDS {
                push(format!("{}'s delivery has {n} words; keep it to {MAX_DELIVERY_WORDS} or fewer", name(&d.speaker)));
            }
        }
        if [&s.action, &s.setting, &s.camera, &s.sound].iter().any(|t| mentions_minor(t))
            || s.dialogue.iter().any(|d| mentions_minor(&d.line) || mentions_minor(&d.delivery)) {
            push("Stories use adults only; remove the reference to a minor".into());
        }
        if s.continuity == "continues" {
            if i == 0 {
                push("The first shot cannot continue a previous shot".into());
            } else if !s.characters.iter().any(|c| shots[i - 1].characters.contains(c)) {
                push("Continues the previous shot but shares no character with it".into());
            }
        }
        let refs: usize = s.characters.iter().filter_map(|id| cast.iter().find(|c| &c.id == id)).map(|c| c.ref_ids.len()).sum();
        if refs > MAX_REFS_PER_SHOT {
            push(format!("{refs} reference images; at most 6 reference images per shot"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stories::DialogueLine;

    fn ch(id: &str, name: &str) -> Character {
        Character {
            id: id.into(), name: name.into(), description: "a tall adult".into(), source: "generated".into(),
            consent: true, adult: true, ref_ids: vec![format!("{id}-ref")], ref_paths: vec![], vault: false, created_at: String::new(), updated_at: String::new(),
        }
    }
    fn story(target_s: u32, cast: &[&str]) -> Story {
        Story {
            id: "s1".into(), title: "T".into(), logline: String::new(), brief: "two adults on a roof".into(), target_s,
            aspect: "16:9".into(), style: "cinematic".into(), cast: cast.iter().map(|c| c.to_string()).collect(),
            voices: vec![], status: "draft".into(), result_image_id: None, vault: false, created_at: String::new(), updated_at: String::new(),
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

#[test] fn valid_story_has_no_issues() {
    let cast = vec![ch("c1", "Mara")];
    let shots = vec![shot("a", 1, 10, &["c1"], "cut"), shot("b", 2, 10, &["c1"], "continues")];
    assert!(validate(&story(20, &["c1"]), &shots, &cast).is_empty());
}
#[test] fn duration_out_of_range() {
    let i = validate(&story(20, &["c1"]), &[shot("a", 1, 3, &["c1"], "cut"), shot("b", 2, 16, &["c1"], "cut")], &[ch("c1","Mara")]);
    assert!(i.iter().any(|x| x.shot == Some(1) && x.message.contains("5–15")));
    assert!(i.iter().any(|x| x.shot == Some(2) && x.message.contains("5–15")));
}
#[test] fn total_outside_tolerance() {
    let i = validate(&story(60, &["c1"]), &[shot("a", 1, 10, &["c1"], "cut")], &[ch("c1","Mara")]);
    assert!(i.iter().any(|x| x.shot.is_none() && x.message.contains("60")));
}
#[test] fn dialogue_too_long_and_wrong_speaker() {
    let mut s = shot("a", 1, 5, &["c1"], "cut");
    s.dialogue = vec![DialogueLine { speaker: "c2".into(), line: "one two three four five six seven eight nine ten eleven twelve thirteen".into(), delivery: String::new() }];
    let i = validate(&story(5, &["c1", "c2"]), &[s], &[ch("c1","Mara"), ch("c2","Ivo")]);
    assert!(i.iter().any(|x| x.message.contains("words")));
    assert!(i.iter().any(|x| x.message.contains("Ivo") && x.message.contains("not in this shot")));
}
#[test] fn cast_limits_and_unknown_character() {
    let i = validate(&story(8, &["c1"]), &[shot("a", 1, 8, &["c1", "c2", "c3"], "cut")], &[ch("c1","Mara")]);
    assert!(i.iter().any(|x| x.message.contains("at most 2")));
    assert!(i.iter().any(|x| x.message.contains("not in the cast")));
}
#[test] fn first_shot_cannot_continue_and_continues_needs_shared_character() {
    let cast = vec![ch("c1","Mara"), ch("c2","Ivo")];
    let i = validate(&story(16, &["c1","c2"]), &[shot("a",1,8,&["c1"],"continues"), shot("b",2,8,&["c2"],"continues")], &cast);
    assert!(i.iter().any(|x| x.shot == Some(1) && x.message.contains("first shot")));
    assert!(i.iter().any(|x| x.shot == Some(2) && x.message.contains("shares no character")));
}
#[test] fn minors_rejected() {
    assert!(mentions_minor("a teen girl on a bike"));
    assert!(mentions_minor("she is 16 years old"));
    assert!(mentions_minor("a 15-year-old boy"));
    assert!(!mentions_minor("she is 30 years old"));
    assert!(mentions_minor("teenage girl"));
    let mut s = shot("a", 1, 8, &["c1"], "cut");
    s.action = "a schoolgirl runs".into();
    let i = validate(&story(8, &["c1"]), &[s], &[ch("c1","Mara")]);
    assert!(i.iter().any(|x| x.message.contains("adults")));
}
#[test] fn minor_detection_variants() {
    for t in ["16yo", "sixteen years old", "a sixteen-year-old", "teenagers at a party", "schoolgirls", "a 15-year-old boy", "she is 16 years old"] {
        assert!(mentions_minor(t), "{t}");
    }
    for t in ["15 years later", "10 years ago", "a minor injury", "hey baby", "she is 30 years old", "a 40yo man"] {
        assert!(!mentions_minor(t), "{t}");
    }
}
#[test] fn consent_and_adult_gate() {
    let mut real = ch("c1","Mara"); real.source = "real_person".into(); real.consent = false;
    let mut kid = ch("c2","Ivo"); kid.adult = false;
    let i = validate(&story(8, &["c1","c2"]), &[shot("a",1,8,&["c1"],"cut")], &[real, kid]);
    assert!(i.iter().any(|x| x.message.contains("Mara") && x.message.contains("consent")));
    assert!(i.iter().any(|x| x.message.contains("Ivo") && x.message.contains("adult")));
}
#[test] fn too_many_reference_images() {
    let mut a = ch("c1","Mara"); a.ref_ids = vec!["1".into(),"2".into(),"3".into(),"4".into()];
    let mut b = ch("c2","Ivo"); b.ref_ids = vec!["5".into(),"6".into(),"7".into()];
    let i = validate(&story(8, &["c1","c2"]), &[shot("a",1,8,&["c1","c2"],"cut")], &[a, b]);
    assert!(i.iter().any(|x| x.message.contains("6 reference images")));
}
#[test] fn delivery_length_and_quotes() {
    let line = |l: &str, d: &str| DialogueLine { speaker: "c1".into(), line: l.into(), delivery: d.into() };
    let mut s = shot("a", 1, 10, &["c1"], "cut");
    s.dialogue = vec![line("Fine.", "turns to the window and says quietly")];
    assert!(validate(&story(10, &["c1"]), &[s.clone()], &[ch("c1","Mara")]).is_empty());
    s.dialogue = vec![
        line("He said \"go\".", "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen"),
        line("Ok.", "says \u{201C}softly\u{201D}"),
    ];
    let i = validate(&story(10, &["c1"]), &[s], &[ch("c1","Mara")]);
    assert!(i.iter().any(|x| x.message.contains("delivery has 16 words")), "{i:?}");
    assert!(i.iter().any(|x| x.message.contains("line has double quotes")), "{i:?}");
    assert!(i.iter().any(|x| x.message.contains("delivery has double quotes")), "{i:?}");
}
#[test] fn voice_phrases_must_describe_adults() {
    let with_voice = |v: &str| Story {
        voices: vec![crate::stories::Voice { character_id: "c1".into(), voice: v.into() }],
        ..story(8, &["c1"])
    };
    let cast = [ch("c1", "Mara")];
    for v in ["a young girl's voice", "a teenage boy's voice", "a high, childlike voice"] {
        let i = preflight(&with_voice(v), &cast);
        assert!(i.iter().any(|x| x.shot.is_none() && x.message == "Mara's voice must describe an adult; stories use adults only"), "{v}: {i:?}");
    }
    assert!(preflight(&with_voice("a low, steady female voice in her 30s"), &cast).is_empty());
    // validate() (used after planning) runs the same check.
    let i = validate(&with_voice("a teenage boy's voice"), &[shot("a", 1, 8, &["c1"], "cut")], &cast);
    assert!(i.iter().any(|x| x.message.contains("voice must describe an adult")), "{i:?}");
}
}
