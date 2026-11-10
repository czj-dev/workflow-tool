package registry

import (
	"encoding/json"
	"errors"
	"fmt"
)

// ValidateArrayParamValue checks the JSON shape used by list and arguments params.
func ValidateArrayParamValue(paramType, value string) error {
	if paramType != "list" && paramType != "arguments" {
		return nil
	}
	var items []any
	if err := json.Unmarshal([]byte(value), &items); err != nil || items == nil {
		return fmt.Errorf("%s 值必须是 JSON 数组", paramType)
	}
	const argumentShape = "arguments 值必须是 {flag:string,values:string[]} 数组"
	for _, item := range items {
		if paramType == "list" {
			if _, ok := item.(string); !ok {
				return fmt.Errorf("list 值必须是 JSON 字符串数组")
			}
			continue
		}
		row, ok := item.(map[string]any)
		if !ok {
			return errors.New(argumentShape)
		}
		if _, ok := row["flag"].(string); !ok {
			return errors.New(argumentShape)
		}
		values, ok := row["values"].([]any)
		if !ok {
			return errors.New(argumentShape)
		}
		for _, value := range values {
			if _, ok := value.(string); !ok {
				return errors.New(argumentShape)
			}
		}
	}
	return nil
}
