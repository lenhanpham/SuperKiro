package proxy

import (
	"strings"
)

// ModelStripDefaults lists upstream model IDs that lack certain content modality
// support. Before translating a request, blocks of the stripped types are removed
// from messages. Mirrors 9router's `strip[]` field in provider registry entries.
var ModelStripDefaults = map[string][]string{
	"deepseek-3.2":     {"image", "audio"},
	"qwen3-coder-next": {"image", "audio"},
}

// stripContentTypes removes content blocks of the given types from every message.
func stripContentTypes(messages interface{}, stripList []string) {
	if len(stripList) == 0 {
		return
	}
	imageTypes := map[string]bool{"image": true, "image_url": true, "input_image": true}
	audioTypes := map[string]bool{"audio_url": true, "input_audio": true}
	shouldStrip := func(blockType string) bool {
		for _, s := range stripList {
			switch s {
			case "image":
				if imageTypes[blockType] {
					return true
				}
			case "audio":
				if audioTypes[blockType] {
					return true
				}
			}
		}
		return false
	}

	msgs, ok := messages.([]interface{})
	if !ok {
		return
	}
	for _, msgIf := range msgs {
		msg, ok := msgIf.(map[string]interface{})
		if !ok {
			continue
		}
		content, ok := msg["content"].([]interface{})
		if !ok {
			continue
		}
		filtered := make([]interface{}, 0, len(content))
		for _, block := range content {
			blockMap, ok := block.(map[string]interface{})
			if !ok {
				filtered = append(filtered, block)
				continue
			}
			blockType, _ := blockMap["type"].(string)
			if shouldStrip(blockType) {
				continue
			}
			filtered = append(filtered, block)
		}
		if len(filtered) == 0 {
			msg["content"] = ""
		} else {
			msg["content"] = filtered
		}
	}
}

// stripFromClaudeRequest applies model strip rules to a ClaudeRequest.
func stripFromClaudeRequest(req *ClaudeRequest) {
	stripList := ModelStripDefaults[strings.ToLower(req.Model)]
	if len(stripList) == 0 {
		return
	}
	msgs := make([]interface{}, len(req.Messages))
	for i, m := range req.Messages {
		msgs[i] = map[string]interface{}{
			"role":    m.Role,
			"content": m.Content,
		}
	}
	stripContentTypes(msgs, stripList)
	for i, m := range msgs {
		if cm, ok := m.(map[string]interface{}); ok {
			if newContent, ok := cm["content"]; ok {
				req.Messages[i] = ClaudeMessage{
					Role:    req.Messages[i].Role,
					Content: newContent,
				}
			}
		}
	}
}

// stripFromOpenAIRequest applies model strip rules to an OpenAIRequest.
func stripFromOpenAIRequest(req *OpenAIRequest) {
	stripList := ModelStripDefaults[strings.ToLower(req.Model)]
	if len(stripList) == 0 {
		return
	}
	msgs := make([]interface{}, len(req.Messages))
	for i, m := range req.Messages {
		msgs[i] = map[string]interface{}{
			"role":    m.Role,
			"content": m.Content,
		}
	}
	stripContentTypes(msgs, stripList)
	for i, m := range msgs {
		if cm, ok := m.(map[string]interface{}); ok {
			if newContent, ok := cm["content"]; ok {
				req.Messages[i].Content = newContent
			}
		}
	}
}
